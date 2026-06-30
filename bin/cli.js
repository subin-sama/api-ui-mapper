#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');
const { runParser } = require('../lib/parser');

// Cap request bodies so an unauthenticated client can't exhaust memory.
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
function collectBody(req, res, cb) {
  let body = '';
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    body += chunk.toString();
    if (body.length > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large' }));
      req.destroy();
    }
  });
  req.on('end', () => { if (!aborted) cb(body); });
}

// Only localhost may reach the server. Rejecting non-local Host headers blocks
// DNS-rebinding attacks against the file/scan endpoints even though we also
// bind to the loopback interface below.
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function isLocalHost(hostHeader) {
  if (!hostHeader) return true; // e.g. HTTP/1.0 clients with no Host
  const host = hostHeader.replace(/:\d+$/, '');
  return ALLOWED_HOSTS.has(host);
}

function printHelp() {
  console.log(`
api-ui-mapper - UI & API Connection Map Generator

Usage:
  api-ui-mapper [options]

With no arguments, starts the visual server on http://localhost:3000
(falling back to the next free port if 3000 is busy). Pass -o/-j to instead
write a static report and exit.

Options:
  -s, --src <dir>          Path to the project's source root directory (default: ./src)
  -a, --api-dirs <list>    Comma-separated list of API folders relative to --src (default: api,srcekyc/api)
  -u, --screens-dir <dir>  UI screens folder relative to --src (default: screens)
  -t, --types-dir <dir>    TS types folder relative to --src (default: types)
  -o, --out-html <file>    Write a static interactive HTML report and exit (default: ./api-mapping.html)
  -j, --out-json <file>    Write the raw mapping JSON data and exit (default: ./api-mapping.json)
  -p, --serve [port]       Start the visual scanner server (default port: 3000, bound to localhost)
  -h, --help               Display this help message
`);
}

// Default options
const options = {
  src: './src',
  apiDirs: 'api,srcekyc/api',
  screensDir: 'screens',
  typesDir: 'types',
  outHtml: null, // Only compiled if explicitly passed
  outJson: null,
  serve: null
};

// Parse argv
const args = process.argv.slice(2);
let explicitlyWantsCompile = false;
let explicitlyWantsServe = false;

// If run with no arguments, default to starting the serve dashboard
if (args.length === 0) {
  explicitlyWantsServe = true;
  options.serve = 3000;
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-h' || arg === '--help') {
    printHelp();
    process.exit(0);
  } else if (arg === '-s' || arg === '--src') {
    options.src = args[++i];
  } else if (arg.startsWith('--src=')) {
    options.src = arg.split('=')[1];
  } else if (arg === '-a' || arg === '--api-dirs') {
    options.apiDirs = args[++i];
  } else if (arg.startsWith('--api-dirs=')) {
    options.apiDirs = arg.split('=')[1];
  } else if (arg === '-u' || arg === '--screens-dir') {
    options.screensDir = args[++i];
  } else if (arg.startsWith('--screens-dir=')) {
    options.screensDir = arg.split('=')[1];
  } else if (arg === '-t' || arg === '--types-dir') {
    options.typesDir = args[++i];
  } else if (arg.startsWith('--types-dir=')) {
    options.typesDir = arg.split('=')[1];
  } else if (arg === '-o' || arg === '--out-html') {
    options.outHtml = args[++i];
    explicitlyWantsCompile = true;
  } else if (arg.startsWith('--out-html=')) {
    options.outHtml = arg.split('=')[1];
    explicitlyWantsCompile = true;
  } else if (arg === '-j' || arg === '--out-json') {
    options.outJson = args[++i];
    explicitlyWantsCompile = true;
  } else if (arg.startsWith('--out-json=')) {
    options.outJson = arg.split('=')[1];
    explicitlyWantsCompile = true;
  } else if (arg === '-p' || arg === '--serve') {
    explicitlyWantsServe = true;
    const nextArg = args[i + 1];
    if (nextArg && !nextArg.startsWith('-')) {
      options.serve = parseInt(nextArg, 10);
      i++;
    } else {
      options.serve = 3000;
    }
  } else if (arg.startsWith('--serve=')) {
    explicitlyWantsServe = true;
    options.serve = parseInt(arg.split('=')[1], 10);
  }
}

// --serve and the static -o/-j output modes are mutually exclusive; warn rather
// than silently ignoring the requested output files.
if (explicitlyWantsCompile && explicitlyWantsServe) {
  console.warn('⚠️ --serve was given, so --out-html/--out-json are ignored. Run without --serve to write a static report.');
}

// 1. Static Compilation Mode
if (explicitlyWantsCompile && !explicitlyWantsServe) {
  const projectDir = process.cwd();
  
  // Load configuration from config file if exists
  const configPath = path.resolve(projectDir, 'api-mapper.config.json');
  if (fs.existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log(`⚙️ Loaded configuration from ${configPath}`);
      Object.assign(options, userConfig);
    } catch (e) {
      console.warn(`⚠️ Warning: Failed to parse api-mapper.config.json: ${e.message}`);
    }
  }

  const srcPath = path.resolve(projectDir, options.src);
  const screensPath = path.resolve(srcPath, options.screensDir);
  const typesPath = path.resolve(srcPath, options.typesDir);
  const apiPaths = options.apiDirs.split(',').map(d => path.resolve(srcPath, d.trim()));

  const finalOutHtml = options.outHtml || './api-mapping.html';
  const finalOutJson = options.outJson || './api-mapping.json';

  const outHtmlPath = path.resolve(projectDir, finalOutHtml);
  const outJsonPath = path.resolve(projectDir, finalOutJson);

  let projectName = 'API Mapper';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(projectDir, 'package.json'), 'utf8'));
    if (pkg.name) {
      projectName = pkg.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  } catch (e) {}

  console.log(`\n🔍 Running static scan...`);
  if (!fs.existsSync(srcPath)) {
    console.error(`❌ Error: Source directory does not exist: ${srcPath}`);
    process.exit(1);
  }

  const result = runParser({
    srcDir: srcPath,
    apiDirs: apiPaths,
    screensDir: screensPath,
    typesDir: typesPath,
    projectName
  });

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.writeFileSync(outJsonPath, JSON.stringify(result, null, 2), 'utf8');

  const templatePath = path.join(__dirname, '..', 'lib', 'template.html');
  let templateHtml = fs.readFileSync(templatePath, 'utf8');
  // The template references __DATA__ twice; replace every occurrence. A function
  // replacement avoids `$`-sequences in the JSON being treated as special.
  const dataJson = JSON.stringify(result);
  const finalHtml = templateHtml.replace(/__DATA__/g, () => dataJson);

  fs.mkdirSync(path.dirname(outHtmlPath), { recursive: true });
  fs.writeFileSync(outHtmlPath, finalHtml, 'utf8');

  let totalConns = 0;
  result.screensMapping.forEach(s => totalConns += s.calls.length);

  console.log(`\n✨ Done! Wrote static report to ${outHtmlPath}`);
  process.exit(0);
}

// 2. Centralized Visual Server Mode
// Helper to check if a port is available
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(true);
      }
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, '0.0.0.0');
  });
}

// Find first available port starting from startPort
async function findAvailablePort(startPort) {
  let port = startPort;
  while (port < 65535) {
    const available = await checkPortAvailable(port);
    if (available) return port;
    port++;
  }
  throw new Error('No available ports found.');
}

(async () => {
  try {
    const startPort = (options.serve && !isNaN(options.serve)) ? options.serve : 3000;
    const port = await findAvailablePort(startPort);
    
    if (port !== startPort) {
      console.log(`⚠️ Port ${startPort} is busy. Falling back to port ${port}.`);
    }
    
    const templatePath = path.join(__dirname, '..', 'lib', 'template.html');
    if (!fs.existsSync(templatePath)) {
      console.error(`❌ Error: Template HTML file not found at ${templatePath}`);
      process.exit(1);
    }
    
    
    let currentMockApiRegistry = {};
    let mockCustomConfigs = {};
    let currentProjectSrcDir = '';

    const server = http.createServer((req, res) => {
      // Reject cross-origin / rebinding access before doing any work.
      // if (!isLocalHost(req.headers.host)) {
      //   res.writeHead(403, { 'Content-Type': 'text/plain' });
      //   res.end('Forbidden: this server only accepts local requests.');
      //   return;
      // }

      const parsedUrl = new URL(req.url, `http://localhost:${port}`);

      // Serve Web Dashboard
      if (req.method === 'GET' && (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html' || parsedUrl.pathname === '/api-mapping')) {
        fs.readFile(templatePath, 'utf8', (err, html) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error loading dashboard: ' + err.message);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html.replace(/__DATA__/g, 'null'));
        });
        return;
      }
      
            
      // Mock Configuration Update
      if (req.method === 'POST' && parsedUrl.pathname === '/api/mock-config') {
        collectBody(req, res, (body) => {
          try {
            const payload = JSON.parse(body);
            if (payload.endpoint) {
              mockCustomConfigs[payload.endpoint] = payload;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Endpoint is required' }));
            }
          } catch(e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          }
        });
        return;
      }

      // Serve API Playground
      if (req.method === 'GET' && (parsedUrl.pathname === '/playground' || parsedUrl.pathname === '/playground.html')) {
        const playgroundPath = path.join(__dirname, '../lib/playground.html');
        if (fs.existsSync(playgroundPath)) {
          fs.readFile(playgroundPath, 'utf8', (err, html) => {
            if (err) {
              res.writeHead(500, { 'Content-Type': 'text/plain' });
              res.end('Error loading playground: ' + err.message);
              return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
          });
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Playground not found');
        }
        return;
      }

      // Directory Explorer API
      if (req.method === 'GET' && parsedUrl.pathname === '/api/browse') {
        const queryPath = parsedUrl.searchParams.get('path');
        const targetPath = queryPath ? path.resolve(queryPath) : os.homedir();
        
        try {
          if (!fs.existsSync(targetPath)) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Directory does not exist.' }));
            return;
          }
          
          const stat = fs.statSync(targetPath);
          if (!stat.isDirectory()) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Path is not a directory.' }));
            return;
          }
          
          const files = fs.readdirSync(targetPath, { withFileTypes: true });
          const folders = [];
          
          files.forEach(entry => {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
              folders.push({
                name: entry.name,
                path: path.join(targetPath, entry.name)
              });
            }
          });
          
          folders.sort((a, b) => a.name.localeCompare(b.name));
          
          const parentPath = path.dirname(targetPath);
          
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            currentPath: targetPath,
            parentPath: parentPath === targetPath ? null : parentPath,
            folders
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Failed to read directory: ' + e.message }));
        }
        return;
      }
      
      // Open File in Editor Endpoint
      if (req.method === 'POST' && parsedUrl.pathname === '/api/open-file') {
        collectBody(req, res, (body) => {
          try {
            const payload = JSON.parse(body);
            const { filePath, srcDir, file } = payload;

            let absoluteFilePath;
            if (file) {
                // If it looks like an absolute path already, use it
                if (file.startsWith('/')) {
                   absoluteFilePath = file;
                } else if (currentProjectSrcDir) {
                   absoluteFilePath = path.resolve(currentProjectSrcDir, file);
                } else {
                   absoluteFilePath = path.resolve(process.cwd(), file);
                }
            } else if (filePath && srcDir) {
                absoluteFilePath = path.resolve(srcDir, filePath);
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing file path parameters.' }));
              return;
            }

            if (!fs.existsSync(absoluteFilePath)) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `File not found at: ${absoluteFilePath}` }));
              return;
            }

            // Open with VS Code or default system handler. execFile passes the
            // path as a single argv entry (no shell), so a path containing shell
            // metacharacters or quotes cannot inject commands.
            execFile('code', [absoluteFilePath], (err) => {
              if (err) {
                execFile('open', [absoluteFilePath], (errFallback) => {
                  if (errFallback) {
                    console.error(`Failed to open file: ${errFallback.message}`);
                  }
                });
              }
            });

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, openedPath: absoluteFilePath }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request: ' + e.message }));
          }
        });
        return;
      }
      
      // API Scan Endpoint
      if (req.method === 'POST' && parsedUrl.pathname === '/api/scan') {
        collectBody(req, res, (body) => {
          try {
            const payload = JSON.parse(body);
            const { projectPath, srcDir, apiDirs, screensDir, typesDir } = payload;
            
            if (!projectPath || !fs.existsSync(projectPath)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Project directory path is invalid or does not exist.' }));
              return;
            }
            
            const resolvedSrc = path.resolve(projectPath, srcDir || './src');
            const resolvedScreens = path.resolve(resolvedSrc, screensDir || 'screens');
            const resolvedTypes = path.resolve(resolvedSrc, typesDir || 'types');
            const resolvedApis = (apiDirs || 'api,srcekyc/api').split(',').map(d => path.resolve(resolvedSrc, d.trim()));
            
            if (!fs.existsSync(resolvedSrc)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Source folder not found at: ${resolvedSrc}` }));
              return;
            }
            
            const scanResult = runParser({
              srcDir: resolvedSrc,
              apiDirs: resolvedApis,
              screensDir: resolvedScreens,
              typesDir: resolvedTypes,
              projectName: path.basename(projectPath)
            });
            
            // Update Mock Server Registry. mockReqJson/mockResJson are already
            // computed by the parser (with full type resolution), so we use
            // them as-is rather than re-deriving from the flattened decl text.
            currentMockApiRegistry = scanResult.apiRegistry;
            currentProjectSrcDir = scanResult.srcDir || '';

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(scanResult));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Scan failed: ' + e.message }));
          }
        });
        return;
      }
      
      
      // Handle CORS Preflight for Mock Server
      if (req.method === 'OPTIONS' && parsedUrl.pathname.startsWith('/mock')) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
      }
      
            // Get current mock registry
      if (req.method === 'GET' && parsedUrl.pathname === '/api/mock-registry') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ apiRegistry: currentMockApiRegistry || {} }));
        return;
      }

      // Mock API Interceptor
      if (parsedUrl.pathname.startsWith('/mock')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        let mockPath = parsedUrl.pathname.replace('/mock', '');
        
        let matchedApi = null;
        for (const key in currentMockApiRegistry) {
           const api = currentMockApiRegistry[key];
           if (api.endpoint && api.endpoint === mockPath) {
              matchedApi = api;
              break;
           }
        }
        
        const custom = mockCustomConfigs[mockPath];
        const hasMock = matchedApi && (custom || matchedApi.mockResJson != null);

        if (hasMock) {
           try {
              let statusCode = 200;
              let mockResponse;

              // A saved custom configuration overrides the generated mock.
              if (custom) {
                 statusCode = parseInt(custom.statusCode) || 200;
                 if (custom.resBody) {
                    try {
                        mockResponse = JSON.parse(custom.resBody);
                    } catch(e) {
                        mockResponse = custom.resBody; // fall back to string if not JSON
                    }
                 }
              }

              // Otherwise serve the type-resolved mock the parser pre-computed.
              if (mockResponse === undefined) {
                 mockResponse = matchedApi.mockResJson != null ? matchedApi.mockResJson : {};
              }

              res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(mockResponse, null, 2));
           } catch(e) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: "Failed to generate mock", details: e.message }));
           }
        } else {
           res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
           res.end(JSON.stringify({ error: "No mock mapping found for this endpoint", requestedEndpoint: mockPath }));
        }
        return;
      }

      // 404 Route
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`\n🚀 API Mapping Visual Server running at: http://localhost:${port} and on your network IP`);
      console.log(`Open http://localhost:${port} in your browser to manage and scan projects.\n`);
    });
  } catch (err) {
    console.error(`\n❌ Failed to start mapping server: ${err.message}`);
  }
})();
