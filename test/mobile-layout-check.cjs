const fs=require('fs');
const {chromium}=require(process.env.DCA_PLAYWRIGHT_MODULE || 'playwright-core');
const assert=require('assert');
const root=require('path').resolve(__dirname,'..')+'/';
process.chdir(process.env.TEMP);
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.DCA_BROWSER_CHANNEL || "chrome"});
 const page=await browser.newPage();
 page.on('pageerror',e=>console.log('PAGE ERROR',e.message));
 const source=fs.readFileSync(root+'public/app.js','utf8').replace(/init\(\);\s*$/, `globalThis.seed = (themeName,count,rackCount) => {
 localStorage.setItem(THEME_KEY,themeName);
 const tile=(id)=>({id:String(id),kind:'number',color:colors[id%4],value:id%13+1});
 state={room:{code:'TEST',phase:'playing',mode:'solo',turnSeconds:60,players:Array.from({length:4},(_,i)=>({id:String(i),name:'Player '+i,isYou:i===0,isActive:i===0,tileCount:14,hasOpened:true}))},you:{id:'0',name:'Me',rack:Array.from({length:rackCount},(_,i)=>tile(200+i)),hasOpened:true},board:Array.from({length:count},(_,i)=>({id:'g'+i,type:'run',tiles:Array.from({length:3},(_,j)=>tile(i*3+j))})),turn:{isYourTurn:true,activePlayerId:'0',deadlineAt:Date.now()+60000},poolCount:50,log:[]};
 hydrateDraft();render();};`);
 await page.route('https://layout.test/**',route=>{
 const path=new URL(route.request().url()).pathname;
 if(path.endsWith('/app.js'))return route.fulfill({contentType:'text/javascript',body:source});
 if(path==='/styles.css')return route.fulfill({contentType:'text/css',body:fs.readFileSync(root+'public/styles.css','utf8')});
 if(path.startsWith('/api/'))return route.fulfill({contentType:'application/json',body:'{}'});
 return route.fulfill({contentType:'text/html',body:fs.readFileSync(root+'public/index.html','utf8')});
 });
 await page.goto('https://layout.test');
 for(const theme of ['classic','sheet'])for(const [width,height] of [[667,375],[844,390],[320,568],[390,844]])for(const count of [0,8,35]){
 await page.setViewportSize({width,height});
 await page.evaluate(([t,c])=>seed(t,c,28),[theme,count]);
 await page.waitForTimeout(180);
 const result=await page.evaluate(()=>{const b=document.querySelector('.board-grid'),r=b.getBoundingClientRect();return {height:r.height,width:r.width,bottom:r.bottom,overflowY:b.scrollHeight-b.clientHeight,overflowX:b.scrollWidth-b.clientWidth,pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,density:b.dataset.boardDensity};});
 console.log(theme,width,height,count,JSON.stringify(result));

 assert(result.height>40,'board collapsed');assert(result.bottom<=height+1,'board outside viewport');assert(result.overflowY<=1 && result.overflowX<=1,'board clipped');assert(result.pageWidth<=width+1,'page overflow');

 }
 // Rotate the existing board without rendering again: ResizeObserver must refit it.
 for (const theme of ['classic','sheet']) {
   await page.setViewportSize({width:844,height:390});
   await page.evaluate(t=>seed(t,35,28),theme);
   await page.setViewportSize({width:320,height:568});
   await page.waitForTimeout(250);
   assert(await page.evaluate(()=>{ const b=document.querySelector('.board-grid'); return b.scrollHeight<=b.clientHeight+1 && b.scrollWidth<=b.clientWidth+1; }), 'rotation clipped board');
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});