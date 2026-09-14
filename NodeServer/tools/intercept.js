// Intercept browser response stages, including every redirect hop. Playwright
// route handlers only see the first URL in a redirect chain, which can leave
// the final script uninstrumented and change primitive-box branch behavior.
async function interceptPage(context, page, store, report, task) {
  const client=await context.newCDPSession(page);
  client.on('Fetch.requestPaused',event=>task((async()=>{
    const {requestId,request,responseStatusCode,responseHeaders,responseErrorReason}=event;
    let completed=false;
    try {
      if(responseErrorReason || !responseStatusCode || responseStatusCode<200 || responseStatusCode>=300 || responseStatusCode===204) {
        await client.send('Fetch.continueRequest',{requestId});completed=true;return;
      }
      const {body,base64Encoded}=await client.send('Fetch.getResponseBody',{requestId});
      const original=base64Encoded ? Buffer.from(body,'base64').toString('utf8') : body;
      const registered=await store.register(request.url,original);
      const headers=(responseHeaders || []).filter(h=>!['content-length','content-encoding','etag','last-modified'].includes(h.name.toLowerCase()));
      await client.send('Fetch.fulfillRequest',{requestId,responseCode:responseStatusCode,responseHeaders:headers,
        body:Buffer.from(registered.source).toString('base64')});
      completed=true;
    } catch(error) {
      report({kind:'gap',reason:'script-interception',url:request.url,message:error.message});
    } finally {
      if(!completed) await client.send('Fetch.continueRequest',{requestId}).catch(error=>{
        report({kind:'gap',reason:'script-resume',url:request.url,message:error.message});
      });
    }
  })()));
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled',{cacheDisabled:true});
  await client.send('Fetch.enable',{patterns:[{urlPattern:'*',resourceType:'Script',requestStage:'Response'}]});
  return client;
}
module.exports={interceptPage};
