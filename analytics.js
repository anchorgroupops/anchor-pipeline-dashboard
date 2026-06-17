(function(){
  var EP='https://n8n.joelycannoli.com/webhook/anchor-analytics';
  var p=new URLSearchParams(window.location.search);
  var ap=p.get('agent')||p.get('a');
  if(ap)localStorage.setItem('ag_agent',ap);
  var aid=localStorage.getItem('ag_agent')||'unknown';
  var sid=sessionStorage.getItem('ag_sid');
  if(!sid){sid=Math.random().toString(36).slice(2,10);sessionStorage.setItem('ag_sid',sid);}
  var pg=window.location.hostname.replace('.joelycannoli.com','');
  var t0=Date.now();
  function send(evt,extra){
    var d={event:evt,agent_id:aid,page:pg,session_id:sid,timestamp:new Date().toISOString()};
    if(extra)Object.keys(extra).forEach(function(k){d[k]=extra[k];});
    try{if(navigator.sendBeacon)navigator.sendBeacon(EP,JSON.stringify(d));
    else fetch(EP,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d),keepalive:true}).catch(function(){});}
    catch(e){}
  }
  send('page_view');
  document.addEventListener('visibilitychange',function(){
    if(document.visibilityState==='hidden')send('page_exit',{duration_sec:Math.round((Date.now()-t0)/1000)});
  });
})();