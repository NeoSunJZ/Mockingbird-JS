const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse, prepareScript, getExpression, wrapExpressionsAtPositions, parseStack } = require('./tools');
const hash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0,24);

class ScriptStore {
  constructor(directory, report = () => {}) {
    this.directory = directory;
    this.report = report;
    this.records = new Map();
    this.served = new Map();
  }
  async register(url, original) {
    const id = hash(`${url}\0${original}`);
    let record = this.records.get(id);
    if (!record) {
      const prepared = prepareScript(original);
      record = { id, url, original, code: prepared.code, generation: 0, candidates: new Map(), gaps: prepared.gaps };
      this.records.set(id, record);
      await fs.mkdir(this.directory, { recursive:true });
      await fs.writeFile(path.join(this.directory,`${id}.original.js`),original);
      for (const gap of prepared.gaps) this.report({kind:'coverage',url,...gap});
    }
    const virtualURL = `mockingbird://scripts/${id}/${record.generation}.js`;
    const source = `${record.code}\n//# sourceURL=${virtualURL}\n`;
    if (!this.served.has(virtualURL)) {
      this.served.set(virtualURL, { record, source, ast: parse(source) });
      await fs.writeFile(path.join(this.directory,`${id}.${record.generation}.js`),source);
    }
    return { source, virtualURL, id };
  }
  observe(event) {
    if (!event.stack || !event.from?.length || ['sink','control'].includes(event.kind)) return;
    const frames = parseStack(event.stack);
    // A proxy may fire in framework code or native glue. Search bounded frames,
    // never assume the second frame is an HTTP .js file.
    const frame = frames.find(frame => this.served.has(frame.fileURL));
    if (!frame) {
      this.report({kind:'gap',reason:'unmapped-execution',stack:event.stack,from:event.from});
      return;
    }
    const served = this.served.get(frame.fileURL);
    if (served.record.code !== served.source.slice(0,served.record.code.length)) return;
    const result = getExpression(served.ast,served.source,{lineNumber:frame.line-1,columnNumber:frame.column-1});
    this.report({kind:'analysis',fileURL:served.record.url,scriptId:served.record.id,generation:served.record.generation,
      line:frame.line,column:frame.column,from:event.from,
      expression:result.expression?.code,statement:result.statement?.code,isController:result.statement?.isController});
    for (const loc of result.candidates) served.record.candidates.set(`${loc.start.index}:${loc.end.index}`,loc);
    if (result.update) this.report({kind:'gap',reason:'update-propagation',fileURL:served.record.url,location:result.update.position});
  }
  async advance(iteration) {
    let changes = 0;
    for (const record of this.records.values()) {
      if (!record.candidates.size) continue;
      const next = wrapExpressionsAtPositions(record.code,new Set(record.candidates.values()),iteration,
        gap => this.report({kind:'gap',url:record.url,...gap}));
      record.candidates.clear();
      if (next !== record.code) { record.code=next;record.generation++;changes++; }
    }
    return changes;
  }
  manifest() {
    return [...this.records.values()].map(({id,url,generation,gaps})=>({id,url,generation,gaps}));
  }
}
module.exports = { ScriptStore, hash };
