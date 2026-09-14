function installSinkHooks(host, runtime) {
  const restores=[];
  const nodeValues=new WeakMap();
  function patch(object,key,replacement) {
    if (!object) return;
    const descriptor=Object.getOwnPropertyDescriptor(object,key);
    if(!descriptor || !descriptor.configurable) return;
    Object.defineProperty(object,key,{...descriptor,...replacement});
    restores.push(()=>Object.defineProperty(object,key,descriptor));
  }
  function written(node,key,value) {
    if([3,4,8].includes(node.nodeType) && ['text','data','nodeValue','textContent'].includes(key)) key='text';
    let slots=nodeValues.get(node);
    if(!slots){slots=new Map();nodeValues.set(node,slots);}
    if(runtime.labels(value).length) slots.set(key,value); else slots.delete(key);
    if(node.isConnected) runtime.sink(key,value,{connected:true});
  }
  function attached(node) {
    if(!node?.isConnected) return;
    if(runtime.labels(node).length) runtime.sink('dom-node',node,{connected:true,operation:'attach'});
    const slots=nodeValues.get(node);
    if(slots) for(const [key,value] of slots) runtime.sink(key,value,{connected:true,operation:'attach'});
    for(const child of node.childNodes || []) attached(child);
  }
  for(const [constructor,keys] of [
    ['Node',['textContent','nodeValue']],['CharacterData',['data']],
    ['Element',['innerHTML','outerHTML']],['HTMLElement',['innerText']],
    ['HTMLInputElement',['value','checked']],['HTMLTextAreaElement',['value']],['HTMLSelectElement',['value']]
  ]) for(const key of keys) {
    const prototype=host[constructor]?.prototype;
    const descriptor=prototype && Object.getOwnPropertyDescriptor(prototype,key);
    if(!descriptor?.set) continue;
    patch(prototype,key,{set(value){
      const connected=Object.getOwnPropertyDescriptor(host.Node.prototype,'isConnected').get.call(this);
      const result=Reflect.apply(descriptor.set,this,[runtime.raw(value)]);
      if(key==='nodeValue' && ![3,4,7,8].includes(this.nodeType)) return result;
      if(key==='textContent' && [9,10].includes(this.nodeType)) return result;
      if(key==='textContent' && [1,11].includes(this.nodeType) && this.firstChild && this.childNodes.length===1 && this.firstChild.nodeType===3) {
        nodeValues.get(this)?.delete(key);
        written(this.firstChild,'text',value);
      } else if(key==='outerHTML' && connected) runtime.sink(key,value,{connected:true});
      else written(this,key,value);
      return result;
    }});
  }
  if(host.Document) {
    const original=host.Document.prototype.createTextNode;
    patch(host.Document.prototype,'createTextNode',{value:function(value){
      const node=Reflect.apply(original,this,[runtime.raw(value)]);
      written(node,'text',value);
      return node;
    }});
  }
  if(host.Node) for(const method of ['appendChild','insertBefore','replaceChild']) {
    const original=host.Node.prototype[method];
    patch(host.Node.prototype,method,{value:function(...args){
      // DocumentFragment becomes empty after insertion, so remember its children.
      const nodes=args[0]?.nodeType===11 ? [...args[0].childNodes] : [args[0]];
      const result=Reflect.apply(original,this,args);
      for(const node of nodes) attached(node);
      return result;
    }});
  }
  if(host.Element) {
    for(const method of ['setAttribute','setAttributeNS']) {
      const original=host.Element.prototype[method];
      patch(host.Element.prototype,method,{value:function(...args){
        const index=method==='setAttribute' ? 1 : 2;
        const result=Reflect.apply(original,this,args.map(runtime.raw));
        const name=runtime.raw(args[index-1]);
        written(this,`attribute:${typeof name==='string' ? name : '[dynamic]'}`,args[index]);
        return result;
      }});
    }
  }
  if(host.Storage) {
    const original=host.Storage.prototype.setItem;
    patch(host.Storage.prototype,'setItem',{value:function(key,value){
      const result=Reflect.apply(original,this,[runtime.raw(key),runtime.raw(value)]);
      runtime.sink('storage-key',key);runtime.sink('storage-value',value);
      return result;
    }});
  }
  return ()=>{for(const restore of restores.reverse()) restore();};
}
module.exports=installSinkHooks;
