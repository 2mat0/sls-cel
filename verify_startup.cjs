const {chromium}=require('C:/Users/matth/node_modules/playwright');
const fs=require('fs');const path=require('path');const http=require('http');
(async()=>{
const server=http.createServer((req,res)=>{const file=path.join(__dirname,'dist',req.url==='/'?'index.html':req.url.split('?')[0]);try{const bytes=fs.readFileSync(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(bytes);}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/assets/*.js',async route=>{await new Promise(r=>setTimeout(r,400));await route.continue();});
await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:"@font-face{font-family:'DM Sans';src:url('https://fonts.gstatic.com/startup-test.woff2')}"}));
let fontRequested;const fontStarted=new Promise(r=>fontRequested=r);let releaseFont;const fontGate=new Promise(r=>releaseFont=r);
await page.route('https://fonts.gstatic.com/**',async route=>{fontRequested();await fontGate;await route.abort();});
await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'commit'});
await page.waitForSelector('#startup');
const early=await page.locator('#app').evaluate(el=>getComputedStyle(el).visibility);
await fontStarted;
const whileFontsPending=await page.locator('#app').evaluate(el=>getComputedStyle(el).visibility);
releaseFont();
await page.waitForSelector('#app[data-ready="true"]',{timeout:30000});
const ready=await page.evaluate(()=>({visibility:getComputedStyle(document.querySelector('#app')).visibility,fonts:document.fonts.status,loader:!!document.querySelector('#startup'),canvas:window.sls.renderer.domElement.width,busy:document.querySelector('#app').getAttribute('aria-busy')}));
await page.screenshot({path:'evidence/startup-ready.png'});
await page.click('#explode');await page.waitForTimeout(250);await page.click('#reset');
const result={early,whileFontsPending,ready,errors};fs.writeFileSync('evidence/startup-verification.json',JSON.stringify(result,null,2));console.log(result);
if(early!=='hidden'||whileFontsPending!=='hidden'||ready.visibility!=='visible'||ready.loader||ready.fonts!=='loaded'||ready.busy!=='false'||errors.length)throw new Error('Startup readiness failed');
// The self-contained download must follow the same reveal sequence.
await page.unroute('**/assets/*.js');
await page.goto('file:///C:/Users/matth/sls-cel/SLS-viewer.html',{waitUntil:'commit'});
await page.waitForSelector('#app[data-ready="true"]');console.log('Standalone readiness passed');
}finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
