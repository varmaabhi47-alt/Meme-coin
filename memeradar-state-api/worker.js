/**
 * MEME.RADAR authoritative D1 state API.
 * Authenticates all state reads/writes and uses optimistic version checks.
 * Bind DB to the existing D1 database and retain BOT_SYNC_SECRET as a secret.
 */
const cors = {
  "Access-Control-Allow-Origin": "https://memeradar-v4.pages.dev",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store"
};
const json=(body,status=200)=>Response.json(body,{status,headers:cors});
function authorized(request,env){const expected=String(env.BOT_SYNC_SECRET||"");return expected.length>0&&(request.headers.get("Authorization")||"")===`Bearer ${expected}`;}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
    if(url.pathname==="/health"&&request.method==="GET")return json({service:"MEME.RADAR state API",status:"ok",storage:"Cloudflare D1",trading:"paper-only"});
    if(url.pathname!=="/state")return json({error:"not_found"},404);
    if(!authorized(request,env))return json({error:"unauthorized"},401);
    if(request.method==="GET"){
      const row=await env.DB.prepare("SELECT payload, version, updated_at FROM portfolio_state WHERE id=?").bind("main").first();
      if(!row)return json({ok:true,portfolio:null,version:0,updated_at:null});
      let portfolio;try{portfolio=JSON.parse(row.payload);}catch{return json({error:"corrupt_state_json"},500);}
      return json({ok:true,portfolio,state:portfolio,version:Number(row.version||0),updated_at:row.updated_at});
    }
    if(request.method!=="POST")return json({error:"method_not_allowed"},405);
    let body;try{body=await request.json();}catch{return json({error:"invalid_json"},400);}
    if(!body||!body.portfolio||typeof body.portfolio!=="object"||Array.isArray(body.portfolio)||!Number.isSafeInteger(Number(body.version))||Number(body.version)<0)return json({error:"portfolio_and_nonnegative_version_required"},400);
    const serialized=JSON.stringify(body.portfolio);if(serialized.length>2_000_000)return json({error:"state_too_large"},413);
    const expected=Number(body.version),updatedAt=new Date().toISOString();
    const result=await env.DB.prepare("UPDATE portfolio_state SET payload=?, updated_at=?, version=version+1 WHERE id=? AND version=?").bind(serialized,updatedAt,"main",expected).run();
    if(!result.meta?.changes){const row=await env.DB.prepare("SELECT version,updated_at FROM portfolio_state WHERE id=?").bind("main").first();return json({success:false,error:"version_conflict",version:Number(row?.version||0),updated_at:row?.updated_at||null},409);}
    return json({success:true,version:expected+1,updated_at:updatedAt});
  }
};