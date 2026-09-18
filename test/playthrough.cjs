const assert=require('assert');
const fs=require('fs');
const http=require('http');
const path=require('path');
const {chromium}=require(process.env.DCA_PLAYWRIGHT_MODULE || 'playwright-core');
const root=path.resolve(__dirname,'..');
const engine=require('../server');
const solo=require('../api/solo');
const source=fs.readFileSync(path.join(root,'public/app.js'),'utf8')+`\nglobalThis.audit={refreshRoomState, get state(){return state}, get draft(){return draft}};`;
process.chdir(process.env.TEMP);
const server=http.createServer((req,res)=>{
 if(req.url==='/app.js'){res.setHeader('content-type','application/javascript');return res.end(source);}
 if(req.url==='/api/solo') return solo(req,res);
 for(const room of engine.rooms.values())engine.advanceRoom(room);
 engine.server.emit('request',req,res);
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
 const errors=[];
 const contexts=[];
 async function fresh(){const ctx=await browser.newContext({viewport:{width:1280,height:800}});contexts.push(ctx);const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.locator('#soloGameForm button[type=submit]').waitFor();return p;}
 const p=await fresh();
 await p.locator('#soloGameForm button[type=submit]').click();await p.locator('.game-page').waitFor();
 assert.equal(await p.locator('.rack-tiles .tile').count(),14);
 await p.locator('[data-action=draw-tile]').click();
 await p.waitForFunction(()=>audit.state.turn.isYourTurn && audit.state.you.rack.length===15);
 await p.reload();await p.locator('.game-page').waitFor();assert.equal(await p.locator('.rack-tiles .tile').count(),15);
 await p.locator('.game-theme-button').click();assert.equal(await p.locator('body').getAttribute('data-theme'),'classic');
 await p.locator('.game-theme-button').click();assert.equal(await p.locator('body').getAttribute('data-theme'),'sheet');
 console.log('PASS solo start, draw, AI turn, reload, themes');
 // Hold an already-fetched state response while the draw action completes.
 let fetched;const fetchedPromise=new Promise(r=>fetched=r);let release;const hold=new Promise(r=>release=r);
 await p.route('**/api/solo',async route=>{if(route.request().postDataJSON().action==='state'){const response=await route.fetch();fetched();await hold;await route.fulfill({response});}else await route.continue();});
 const refresh=p.evaluate(()=>audit.refreshRoomState());await fetchedPromise;
 await p.locator('[data-action=draw-tile]').click();await p.waitForFunction(()=>audit.state.you.rack.length===16);
 release();await refresh;await p.waitForTimeout(100);
 assert.equal(await p.evaluate(()=>audit.state.you.rack.length),16,'stale polling rolled back a draw');
 await p.unroute('**/api/solo');console.log('PASS delayed polling cannot roll back draw');
 // Returning home while an old refresh is in flight must stay home.
 let fetched2;const ready2=new Promise(r=>fetched2=r);let release2;const hold2=new Promise(r=>release2=r);
 await p.route('**/api/solo',async route=>{if(route.request().postDataJSON().action==='state'){const response=await route.fetch();fetched2();await hold2;await route.fulfill({response});}else await route.continue();});
 const refresh2=p.evaluate(()=>audit.refreshRoomState());await ready2;
 await p.locator('.game-home-button').click();release2();await refresh2;await p.waitForTimeout(100);
 assert.equal(await p.locator('.game-page').count(),0,'late response reopened game');
 await p.unroute('**/api/solo');console.log('PASS home remains home during in-flight requests');
 const host=await fresh();await host.locator('#createRoomForm [name=playerName]').fill('Host');await host.locator('#createRoomForm [name=visibility][value=public]').check();await host.locator('#createRoomForm button[type=submit]').click();await host.locator('.lobby-page').waitFor();
 const code=await host.locator('.invite-box strong').innerText();
 const guests=[];
 for(let i=0;i<3;i++){const g=await fresh();if(i===0){await g.locator('[data-public-player-name]').fill('Guest0');await g.locator(`[data-room-code="${code}"]`).click();}else{await g.locator('#joinRoomForm [name=playerName]').fill('Guest'+i);await g.locator('#joinRoomForm [name=code]').fill(code);await g.locator('#joinRoomForm button[type=submit]').click();}await g.locator('.lobby-page').waitFor();guests.push(g);}
 await host.waitForFunction(()=>audit.state.room.players.length===4);await host.locator('[data-action=start-game]').click();
 for(const page of [host,...guests])await page.locator('.game-page').waitFor();
 const pages=[host,...guests];let active;
 for(const page of pages)if(await page.evaluate(()=>audit.state.turn.isYourTurn))active=page;
 const before=await active.locator('.rack-tiles .tile').count();await active.locator('[data-action=draw-tile]').click();await active.waitForFunction(n=>audit.state.you.rack.length===n,before+1);
 console.log('PASS public listing, invite join, 4-player start, turn draw');
 // Deal deterministic hands to verify UI editing and submission against the real engine.
 const room=engine.rooms.get(code);const owner=room.players[0];
 room.activeIndex=0;room.deadlineAt=Date.now()+120000;room.turnDirty=false;room.board=[];
 owner.hasOpened=false;owner.rack=[1,2,3,10,11,12].map(n=>`n-red-${n}-1`).concat(['n-blue-7-1','n-black-7-1','n-orange-7-1','j-1']);
 const dealt=new Set(room.players.flatMap(player=>player.rack));room.deck=engine.ALL_TILE_IDS.filter(id=>!dealt.has(id));
 await host.evaluate(()=>audit.refreshRoomState());
 async function placeFirst(id){await host.locator(`.rack-tiles [data-tile-id="${id}"]`).click();await host.locator('[data-action=new-group]').click();}
 async function add(id){await host.locator(`.rack-tiles [data-tile-id="${id}"]`).click();await host.locator('.meld [data-action=add-to-group]').last().click();}
 await placeFirst('n-red-1-1');await add('n-red-2-1');await add('n-red-3-1');
 await host.locator('[data-action=submit-turn]').click();await host.waitForFunction(()=>document.querySelector('#toast').textContent.includes('06'));
 assert.equal(await host.locator('.board-grid .tile').count(),3,'invalid opening must preserve draft');
 await host.locator('[data-action=undo-draft]').click();assert.equal(await host.locator('.board-grid .tile').count(),0);
 await placeFirst('n-red-12-1');await add('n-red-10-1');await add('n-red-11-1');
 assert.deepEqual(await host.locator('.board-grid .tile b').allTextContents(),['10','11','12']);
 await host.locator('[data-action=submit-turn]').click();await host.waitForFunction(()=>audit.state.you.hasOpened);
 await guests[0].evaluate(()=>audit.refreshRoomState());assert.equal(await guests[0].locator('.board-grid .tile').count(),3);
 assert.equal(await guests[0].locator('.recent-opponent-play').count(),3);
 console.log('PASS 30-point rejection preserves draft, undo, sorting, submit, opponent highlights');
 room.activeIndex=0;room.deadlineAt=Date.now()+130000;await host.evaluate(()=>audit.refreshRoomState());
 await host.locator('[data-action=sort-rack][data-sort=group]').click();
 const holdTile=host.locator('.rack-tiles [data-tile-id="n-blue-7-1"]');const box=await holdTile.boundingBox();await host.mouse.move(box.x+box.width/2,box.y+box.height/2);await host.mouse.down();await host.waitForTimeout(650);
 assert((await host.locator('.batch-selected').count())>=2,'same-value long hold must select at least a pair');await host.mouse.up();
 await host.locator('.game-home-button').click();await host.locator('#soloGameForm').waitFor();await guests[0].evaluate(()=>audit.refreshRoomState());await guests[0].locator('#soloGameForm').waitFor();
 assert.equal(engine.rooms.has(code),false,'host exit must remove room');
 console.log('PASS long-press group selection and host exit returns guests home');
 const closing=await fresh();await closing.locator('#createRoomForm [name=playerName]').fill('Closing host');await closing.locator('#createRoomForm button[type=submit]').click();await closing.locator('.lobby-page').waitFor();
 const closingCode=await closing.locator('.invite-box strong').innerText();
 await closing.reload();await closing.locator('.lobby-page').waitFor();
 assert.deepEqual(engine.rooms.get(closingCode).pendingDepartures || {},{},'reload must reconnect');
 await closing.goto('about:blank');
 for(let retry=0;retry<20 && !Object.keys(engine.rooms.get(closingCode).pendingDepartures || {}).length;retry++)await new Promise(r=>setTimeout(r,100));
 assert(Object.keys(engine.rooms.get(closingCode).pendingDepartures || {}).length===1,'page exit must deliver leave beacon');
 console.log('PASS page-exit beacon and reload reconnection');
 assert.deepEqual(errors,[],'browser runtime errors');
 } finally {await browser.close();for(const room of engine.rooms.values()){clearTimeout(room.turnTimer);clearTimeout(room.aiTimer);}engine.rooms.clear();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exit(1)});