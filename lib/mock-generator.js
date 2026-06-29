/**
 * mock-generator.js
 * Generates mock JSON data based on TypeScript interface declarations.
 */

function generateMockFromTypeDecl(typeDecl) {
  if (!typeDecl) return {};

  let cleanDecl = typeDecl
    .replace(/\/\/.*$/gm, '') // Remove single line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi line comments
    .trim();

  const startIdx = cleanDecl.indexOf('{');
  const endIdx = cleanDecl.lastIndexOf('}');
  
  if (startIdx !== -1 && endIdx !== -1) {
    cleanDecl = cleanDecl.substring(startIdx, endIdx + 1);
  }
  
  try {
    return parseMock(cleanDecl);
  } catch (e) {
    console.error("Mock generation error:", e);
    return { _error: "Failed to generate mock", _rawDecl: typeDecl };
  }
}

function parseMock(declText) {
  let i = 0;
  
  function parseObject() {
    const obj = {};
    while (i < declText.length) {
      skipWhitespace();
      if (i >= declText.length || declText[i] === '}') {
        if (declText[i] === '}') i++;
        return obj;
      }
      
      let key = parseKey();
      if (!key) {
        skipToNextDelimiter();
        continue;
      }
      
      skipWhitespace();
      let optional = false;
      if (declText[i] === '?') {
        optional = true;
        i++;
      }
      
      skipWhitespace();
      if (declText[i] !== ':') {
        skipToNextDelimiter();
        continue;
      }
      i++; // Skip ':'
      
      skipWhitespace();
      
      key = key.replace(/['"]/g, '').trim();
      let value = parseValue(key);

      obj[key] = value;
      
      skipWhitespace();
      if (declText[i] === ';' || declText[i] === ',') {
        i++;
      }
    }
    return obj;
  }
  
  function parseKey() {
    let key = '';
    while (i < declText.length && /[a-zA-Z0-9_'"$]/.test(declText[i])) {
      key += declText[i];
      i++;
    }
    return key;
  }
  
  function parseValue(key) {
    let valStr = '';
    if (declText[i] === '{') {
      i++;
      let obj = parseObject();
      skipWhitespace();
      if (declText.substring(i, i+2) === '[]') {
        i += 2;
        return [obj];
      }
      return obj;
    }
    
    while (i < declText.length && declText[i] !== ';' && declText[i] !== ',' && declText[i] !== '}' && declText[i] !== '\n') {
      valStr += declText[i];
      i++;
    }
    
    valStr = valStr.trim();
    
    if (valStr.endsWith('[]')) return [getMockValueForType(valStr.slice(0, -2).trim(), key)];
    if (valStr.startsWith('Array<') && valStr.endsWith('>')) return [getMockValueForType(valStr.substring(6, valStr.length - 1).trim(), key)];
    if (valStr.includes('|')) valStr = valStr.split('|')[0].trim();
    
    return getMockValueForType(valStr, key);
  }
  
  function skipWhitespace() {
    while (i < declText.length && /\s/.test(declText[i])) i++;
  }
  
  function skipToNextDelimiter() {
    while (i < declText.length && declText[i] !== ';' && declText[i] !== '\n') i++;
    if (i < declText.length) i++;
  }
  
  function getMockValueForType(type, key) {
    if (!type) return "";
    type = type.toLowerCase();
    const keyLower = (key || '').toLowerCase();
    
    if (type.startsWith("'") || type.startsWith('"')) return type.replace(/['"]/g, '');
    if (type === 'true') return true;
    if (type === 'false') return false;
    if (!isNaN(type) && type !== '') return Number(type);
    
    if (type.includes('string')) {
      if (keyLower.includes('token')) return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...";
      if (keyLower.includes('email')) return "user@example.com";
      if (keyLower.includes('phone') || keyLower.includes('tel')) return "0812345678";
      if (keyLower.includes('id') || keyLower.includes('no')) return "ID-9999-XYZ";
      if (keyLower.includes('name')) return "John Doe";
      if (keyLower.includes('date') || keyLower.includes('time')) return new Date().toISOString();
      if (keyLower.includes('url') || keyLower.includes('link')) return "https://mock.link/xyz";
      if (keyLower.includes('ip')) return "192.168.1.1";
      if (keyLower.includes('status')) return "SUCCESS";
      if (keyLower.includes('lang')) return "TH";
      if (keyLower.includes('device')) return "IOS";
      if (keyLower.includes('code')) return "0000";
      return "Mock String";
    }
    if (type.includes('number')) {
      if (keyLower.includes('amount') || keyLower.includes('price') || keyLower.includes('balance')) return 1500.50;
      if (keyLower.includes('percent')) return 7.5;
      return 123;
    }
    if (type.includes('boolean')) return true;
    if (type.includes('date')) return new Date().toISOString();
    if (type === 'any' || type === 'record<string,any>') return { mockData: "any" };
    return { _type: type };
  }
  
  skipWhitespace();
  if (declText[i] === '{') {
    i++;
  }
  return parseObject();
}

module.exports = { generateMockFromTypeDecl };
