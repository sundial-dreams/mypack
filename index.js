const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const { transformFileAsync, transformFromAstAsync } = require("@babel/core");
const traverser = require("@babel/traverse");
const config = require("./config");
const mkOneDir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);

async function mkdir (dir) {
  const dirs = dir.split("/").filter(Boolean);
  let cur = "";
  for (let d of dirs) {
    cur += d;
    if (!fs.existsSync(cur)) await mkOneDir(cur);
    cur += "/"
  }
}

async function getDepsAndCode (filename) {
  const { ast } = await transformFileAsync(filename, { sourceType: "module", ast: true });
  const { code } = await transformFromAstAsync(ast, null, { presets: ["@babel/preset-env"] });
  const deps = [];
  traverser.default(ast, {
    ImportDeclaration ({ node }) { deps.push(node.source.value); }
  });
  return { code, deps }
}

function resolveJsFile (filename) {
  if (fs.existsSync(filename)) return filename;
  if (fs.existsSync(filename + ".js")) return filename + ".js";
  return filename;
}

async function makeDepsGraph (entry) {
  const graph = {};

  async function makeDepsGraph (filename) {
    if (graph[filename]) return; // 防止重复加载模块
    const mapping = {}; // 定义相对路径到绝对路径的一个映射
    const dirname = path.dirname(filename);
    const { code, deps } = await getDepsAndCode(resolveJsFile(filename));
    graph[filename] = { code }; // 解决循环依赖
    for (let dep of deps) {
      mapping[dep] = path.join(dirname, dep); // dep是相对路径，path.join(dirname, dep)是绝对路径
      await makeDepsGraph(mapping[dep]); // 深搜
    }
    graph[filename].mapping = mapping;
  }

  await makeDepsGraph(entry);
  return graph;
}

async function writeJsBundle (entry) {
  const graph = await makeDepsGraph(entry);
  let modules = "";
  for (let filename of Object.keys(graph)) {
    modules += `'${ filename }': {
     mapping: ${ JSON.stringify(graph[filename].mapping) },
     fn: function (require, module, exports) {
       ${ graph[filename].code }
     }  
    },`
  }

  const bundle = `
   !function (modules) {
      var cache = {}; 
      var count = {};
      
      function require(moduleId) {
        if (cache[moduleId]) return cache[moduleId];
        count[moduleId] || (count[moduleId] = 0);
        count[moduleId] ++;
        var mapping = modules[moduleId].mapping;
        var fn = modules[moduleId].fn;
        
        function _require(id) { 
          var mId = mapping[id]; 
          if (count[mId] >= 2) return {};
          return require(mId);
        }
        var module = { exports: {} };
        fn(_require, module, module.exports);
        return module.exports;
      }
      
      require('${ entry }');
    } ({${ modules }})`;
  await mkdir(config.output.path);
  await writeFile(`${ config.output.path }/${ config.output.filename }`, bundle);
}

async function main () {
  await writeJsBundle(config.entry);
}

main().catch(console.error);
