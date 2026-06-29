# api-ui-mapper

An interactive UI-to-API connection mapping dashboard generator for React, React Native, and web projects.

`api-ui-mapper` crawls your codebase to automatically trace which User Interface screens invoke which backend API endpoints, displaying the connections with a stunning, high-tech glassmorphic dark-theme dashboard.

## Features

- **Bidirectional Mapping**: Inspect from **UI Screens -> Called APIs** or **API Endpoints -> Calling UI Screens**.
- **Type Definitions Extraction**: Resolves and displays TypeScript interfaces/types for request payloads and response return data inside collapsible accordions.
- **Deep Usage Analysis**: Filters APIs by "Used by Screens", "Used Elsewhere Only" (e.g. Sagas, components, helpers), and "Truly Unused" (dead code).
- **Interactive Visualizations**: Draws dynamic SVG connections linking active screen and API blocks.
- **Lightweight**: Only two runtime dependencies (`@babel/parser` and `@babel/traverse`) for JSX/TSX parsing; the server, report, and mock engine use Node.js built-ins.
- **Built-in Preview Server**: Spin up a preview web server directly from the command line (bound to `localhost`).

---

## Installation

### Method 1: Global CLI (Recommended for general use)
Install the package globally from the folder directory:
```bash
npm install -g /path/to/tools/api-ui-mapper
```
Once installed, run it in any project root directory using:
```bash
api-ui-mapper [options]
```

### Method 2: Project Developer Dependency
Install it locally in another project:
```bash
npm install --save-dev /path/to/tools/api-ui-mapper
```
Run it via `npx` in that project:
```bash
npx api-ui-mapper [options]
```

### Method 3: One-off execution (without installation)
Run the script directly using `node` pointing to the script path:
```bash
node /path/to/tools/api-ui-mapper/bin/cli.js [options]
```

---

## Command Line Options

| Argument | Alias | Description | Default |
|---|---|---|---|
| `--src <dir>` | `-s` | Path to the project's source root directory | `./src` |
| `--api-dirs <list>` | `-a` | Comma-separated list of API folders relative to `--src` | `api,srcekyc/api` |
| `--screens-dir <dir>` | `-u` | UI screens folder relative to `--src` | `screens` |
| `--types-dir <dir>` | `-t` | TS types folder relative to `--src` | `types` |
| `--out-html <file>` | `-o` | Output file path for the interactive HTML report | `./api-mapping.html` |
| `--out-json <file>` | `-j` | Output file path for the raw mapping JSON data | `./api-mapping.json` |
| `--serve <port>` | `-p` | Start a local preview server on the specified port | `3000` |
| `--help` | `-h` | Display this help message | - |

---

## Example Usage

### 1. Launch the Dashboard (default)
Run in the root of your project with no arguments:
```bash
api-ui-mapper
```
This starts the interactive visual server on port `3000` (falling back to the next free port if 3000 is busy), where you can browse to a project, scan it, and explore the map. The server listens on `0.0.0.0` allowing local network access.

### 2. Generate a Static Report
To instead write a self-contained HTML/JSON report and exit, pass an output flag. This scans `./src` (mapping `./src/api`, `./src/srcekyc/api`, `./src/screens`, and `./src/types`):
```bash
api-ui-mapper --out-html=./api-mapping.html --out-json=./api-mapping.json
```

### 3. Custom Directories
If your project structures APIs in `src/services/api` and screens in `src/views`:
```bash
api-ui-mapper --api-dirs=services/api --screens-dir=views --out-html=./dist/report.html
```

### 4. Preview on a Custom Port
Launch the visual server on port `4000`:
```bash
api-ui-mapper --serve=4000
```
Then navigate to **http://localhost:4000** in your browser.

---

## Technical Notes & Limitations (Why is something missing?)

`api-ui-mapper` uses deterministic static analysis to trace imports, exports, and call parameters without running your code. UI structure and event-handler wiring are resolved by parsing each screen's JSX/TSX into a Babel AST, while API endpoints, methods, and type annotations are extracted with targeted regular expressions. Here are important conventions to keep in mind if some connections are missing:

### 1. API Detection Rules
- **Named Exports**: The parser detects API functions declared as named exports (e.g., `export const getUser = ...` or `export function getUser()`). Default exports (`export default ...`) are currently not cataloged as standalone API hooks.
- **HTTP Client calls**: It scans inside the function body for HTTP client actions like `request.post('url')`, `request.get(...)`, `axios.post(...)`, or configurations with `url:` and `method:`. If no direct network request is made in the function body, it will default the endpoint to `(config/local action)` and the method to `LOCAL`.

### 2. UI-to-API Connections Mapping
- **Direct Imports**: A UI Screen is mapped to an API if it **directly imports** the API file/function.
- **Redux / Saga Exclusions**: If your screen dispatches a Redux action (e.g., `dispatch(loginAction(payload))`) and a Redux Saga actually imports and calls the API (e.g., `yield call(login, payload)`), the direct connection between **Screen -> API** won't be drawn. Instead:
  - The API will be marked as used under `Other Code Files` (referencing the Saga file).
  - The screen itself will show `0 API calls` since it has no direct imports.
- **Import Path Filter**: The parser scans imports pointing to paths containing `/api/` or matching your configured `--api-dirs` for efficiency. Imports from other files might be skipped for connection tracing.

### 3. TypeScript Type Resolutions
- **Dedicated Folder**: TypeScript payloads are extracted from files inside your configured `--types-dir`. Types defined locally inside API files or screen files are not indexed in the global TS cache.
- **Annotation**: The API function signature must explicitly declare the parameter type and return type. E.g., `export const login = (data: LoginReq): Promise<LoginRes> => ...`

### 4. Active Flow / Reachability Analysis
- **Entry Points**: The reachability crawler starts at your entry files (e.g., `App.tsx`, `index.js`).
- **Unreachable Badges**: If a screen or API is not reachable from the entry file, it gets marked as `⚠️ Inactive Flow (Dead Code)`. If you see an active screen marked as inactive, ensure your main entry file name is in the candidate list or that the import path resolves relative to the source root.

