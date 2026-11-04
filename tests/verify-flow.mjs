import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const host = createRequire(new URL('../../../apps/cli/package.json', import.meta.url));
const sharp = host('sharp');
const workspace = await mkdtemp(path.join(tmpdir(), 'anki-flow-'));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const binary = process.env.ANKI_CLI_BIN ?? path.join(repo, 'tools/anki-cli/target/debug/anki-cli');
const cli = ['--import', host.resolve('tsx'), path.join(repo, 'apps/cli/src/cli.ts')];
const png = await sharp({create:{width:128,height:64,channels:3,background:'#ef4477'}}).png().toBuffer();
const secondPng = await sharp({create:{width:128,height:64,channels:3,background:'#eaff33'}}).png().toBuffer();
const audio = Buffer.from('ID3-fixture-audio');
const cards = [{ name:'apple',unit:2,symbol:'/ˈæpəl/',chn:'苹果',example_en:'I eat an apple.',example_cn:'我吃一个苹果。',word_family:'apples',memory_tips:'联想水果',difficulty:'1',collocations:'an apple a day 每天一个苹果',image_prompt:'A student eating a red apple.' }];
const calls = [];
const batchSizes = [];
const server = createServer((request, response) => { void serve(request,response).catch(error => { response.writeHead(500);response.end(String(error)); }); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
try {
    await seed();
    const source = path.join(repo, 'backend/app-core/src/presets/anki-generate.json');
    const definition = JSON.parse(await readFile(source, 'utf8'));
    assert.equal(definition.id, 'anki-generate');
    assert.deepEqual(definition.functions.map(fn => fn.id), ['anki-build','anki-recognize-group','anki-complete-batch']);
    const file = await save('isolated/anki-generate.flow', definition);
    assert.deepEqual(await readdir(path.dirname(file)), ['anki-generate.flow']);
    const parameters = await save('parameters.json', { words:'Unit 2\napple',generateImages:true,generateAudio:true,voice:'fixture-voice' });
    const bindings = await save('bindings.json', { text:'text',image:'image',speech:'speech' });
    await invoke('run','-f',file,'--params',parameters,'--connection-bindings',bindings);
    assert.deepEqual([...calls].sort(), ['chat','image','speech','speech']);
    const files = await walk(path.join(workspace,'anki-output'));
    const manifest = files.find(file => file.endsWith('anki.manifest.yaml'));
    const packageFile = files.find(file => file.endsWith('deck.apkg'));
    assert.ok(manifest); assert.ok(packageFile);
    const yaml = await readFile(manifest,'utf8'); assert.ok(yaml.includes('version: 1')); assert.ok(yaml.includes('audio_example:'));
    const { stdout: inspected } = await promisify(execFile)(binary, ['pkg2md',packageFile,'--output',path.join(workspace,'unpacked')]);
    assert.equal(JSON.parse(inspected).cards,1);
    const imported = JSON.parse(await readFile(path.join(workspace,'unpacked/cards.json'),'utf8'));
    assert.equal(imported[0].name,'apple'); assert.equal(imported[0].chn,'苹果');
    const runs = await readdir(path.join(workspace,'runs'));
    const outputs = JSON.parse(await readFile(path.join(workspace,'runs',runs[0],'result.json'),'utf8'));
    assert.equal(path.join(workspace,outputs.manifest.path),manifest);
    assert.equal(path.join(workspace,outputs.package.path),packageFile);
    const before = calls.length; await invoke('resume',runs[0]); assert.equal(calls.length,before);
    const textOnly = await save('text-only.json',{words:'apple',outputDirectory:'text-output'});
    const textBinding = await save('text-bindings.json',{text:'text'});
    await invoke('run','-f',file,'--params',textOnly,'--connection-bindings',textBinding);
    assert.equal(calls.length,before+1);assert.equal(calls.at(-1),'chat');
    assert.ok((await walk(path.join(workspace,'text-output'))).some(file=>file.endsWith('deck.apkg')));
    const invalid = await save('invalid.json',{words:'apple\napple'});
    await assert.rejects(invoke('run','-f',file,'--params',invalid,'--connection-bindings',textBinding));
    assert.equal(calls.length,before+1);
    const photoParams = await save('photo-parameters.json', { images:[{type:'image_url',image_url:{url:`data:image/png;base64,${png.toString('base64')}`}}],outputDirectory:'photo-output',generateImages:true,generateAudio:true,voice:'fixture-voice' });
    const photoBindings = await save('photo-bindings.json', {text:'text',vision:'vision',image:'image',speech:'speech'});
    await assert.rejects(invoke('run','-f',file,'--params',photoParams,'--connection-bindings',textBinding), /connection|连接/i);
    assert.equal(calls.length,before+1, 'Missing vision binding must not fall back to the text model');
    const photoStart = calls.length;
    const existingRuns = new Set(await readdir(path.join(workspace,'runs')));
    await invoke('run','-f',file,'--params',photoParams,'--connection-bindings',photoBindings);
    assert.deepEqual(calls.slice(photoStart),['vision']);
    const photoRun = (await readdir(path.join(workspace,'runs'))).find(id=>!existingRuns.has(id));
    assert.ok(photoRun);
    const state = JSON.parse(await readFile(path.join(workspace,'runs',photoRun,'run.json'),'utf8'));
    assert.equal(state.status,'waiting');assert.equal(state.pendingInteractions.length,1);
    assert.equal(state.flow.parameters.images[0].source.asset.kind,'input');
    assert.ok(!JSON.stringify(state.flow.parameters).includes('base64'));
    assert.equal(state.pendingInteractions[0].payload.values.cards[0].chn,'苹果?');
    await invoke('resume',photoRun);
    assert.deepEqual(calls.slice(photoStart),['vision']);
    await invoke('respond',photoRun,state.pendingInteractions[0].interactionId,'--value',JSON.stringify({cards:[{name:'apple',unit:2,symbol:'/a/',chn:'青苹果'}]}));
    await invoke('resume',photoRun);
    assert.deepEqual(calls.slice(photoStart).sort(),['chat','image','speech','speech','vision']);
    const photoPackage = (await walk(path.join(workspace,'photo-output'))).find(file=>file.endsWith('deck.apkg'));
    assert.ok(photoPackage);
    await promisify(execFile)(binary,['pkg2md',photoPackage,'--output',path.join(workspace,'photo-unpacked')]);
    const corrected = JSON.parse(await readFile(path.join(workspace,'photo-unpacked/cards.json'),'utf8'));
    assert.equal(corrected[0].chn,'青苹果');assert.equal(corrected[0].symbol,'/a/');
    const finalCalls = calls.length;await invoke('resume',photoRun);assert.equal(calls.length,finalCalls);
    const grouped = await verifyGroups(file, textBinding, photoBindings);
    console.log(JSON.stringify({success:true,workspace,manifest,package:packageFile,calls,restoredWithoutRequests:true,textOnly:true,invalidInputBlockedBeforeModel:true,photoReviewAndResume:true,correctedPhotoPackage:photoPackage,grouped},null,2));
} finally { await new Promise(resolve => server.close(resolve)); }

async function serve(request,response) {
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    if(request.url.endsWith('/chat/completions')) {
        const vision = body.messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url'));
        calls.push(vision?'vision':'chat');
        const recognized = [];
        if(vision) for (const part of body.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(part=>part.image_url)) {
            assert.ok(part.image_url.url.startsWith('data:image/jpeg;base64,'));
            const actual=Buffer.from(part.image_url.url.split(',')[1],'base64'), meta=await sharp(actual).metadata();
            assert.equal(meta.format,'jpeg');assert.equal(meta.width,128);assert.equal(meta.height,64);
            const pixels=await sharp(actual).raw().toBuffer();assert.equal(pixels[0],pixels[1]);assert.equal(pixels[1],pixels[2]);
            recognized.push(pixels[0] > 150 ? {name:'pear',unit:3,symbol:'',chn:'梨?'} : {name:'apple',unit:2,symbol:'',chn:'苹果?'});
        }
        const generated = vision ? recognized : completeCards(body.messages);
        if (!vision) batchSizes.push(generated.length);
        chatReply(response, JSON.stringify({cards:generated}), body.stream);
    } else if(request.url.endsWith('/images/generations')) {
        calls.push('image');assert.equal(body.prompt,cards[0].image_prompt);
        response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
    } else {
        calls.push('speech');assert.equal(body.voice,'fixture-voice');assert.ok([cards[0].name,cards[0].example_en].includes(body.input));
        response.writeHead(200,{'Content-Type':'audio/mpeg'});response.end(audio);
    }
}
function completeCards(messages) {
    const text = messages.filter(message=>message.role==='user').map(message=>message.content).join('\n');
    const source = text.split('已校验的单词卡片输入：\n')[1]?.split('\n\n请逐字段')[0];
    assert.ok(source, 'Generation must use the validated batch input');
    return JSON.parse(source).map(card=>({...cards[0],...card,symbol:card.symbol || cards[0].symbol,chn:card.chn || cards[0].chn}));
}
function chatReply(response, content, streaming) {
    const usage={prompt_tokens:2,completion_tokens:3,total_tokens:5};
    if (!streaming) {
        response.writeHead(200,{'Content-Type':'application/json'});
        response.end(JSON.stringify({id:'fixture',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage}));
        return;
    }
    response.writeHead(200,{'Content-Type':'text/event-stream'});
    response.end(`data: ${JSON.stringify({id:'fixture',choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage})}\n\ndata: [DONE]\n\n`);
}
async function verifyGroups(file, textBinding, photoBindings) {
    const wordsGroups=[Array.from({length:21},(_,index)=>`a${index}`).join('\n'),Array.from({length:24},(_,index)=>`b${index}`).join('\n')];
    const report=[];
    for (const processingMode of ['combined','grouped']) {
        const start=batchSizes.length, directory=`batch-${processingMode}`;
        const params=await save(`${directory}.json`,{wordsGroups,processingMode,outputDirectory:directory});
        await invoke('run','-f',file,'--params',params,'--connection-bindings',textBinding);
        assert.deepEqual(batchSizes.slice(start).sort((a,b)=>a-b), processingMode==='combined'?[5,20,20]:[1,4,20,20]);
        const packed=await unpack(directory);
        assert.equal(packed.length,45);assert.equal(new Set(packed.map(card=>card.name)).size,45);
        report.push({mode:processingMode,textCards:packed.length,batchSizes:batchSizes.slice(start)});
        await verifyImageGroups(file, photoBindings, processingMode);
    }
    return report;
}
async function verifyImageGroups(file, bindings, processingMode) {
    const directory=`images-${processingMode}`, start=calls.length;
    const images=[png,secondPng].map(bytes=>({type:'image_url',image_url:{url:`data:image/png;base64,${bytes.toString('base64')}`}}));
    const params=await save(`${directory}.json`,{images,processingMode,outputDirectory:directory});
    const previous=new Set(await readdir(path.join(workspace,'runs')));
    await invoke('run','-f',file,'--params',params,'--connection-bindings',bindings);
    assert.equal(calls.slice(start).filter(call=>call==='vision').length,processingMode==='combined'?1:2);
    const id=(await readdir(path.join(workspace,'runs'))).find(id=>!previous.has(id));
    const state=JSON.parse(await readFile(path.join(workspace,'runs',id,'run.json'),'utf8'));
    assert.equal(state.status,'waiting');
    const interaction=state.pendingInteractions[0];
    assert.deepEqual(interaction.payload.values.cards.map(card=>card.name),['apple','pear']);
    await invoke('respond',id,interaction.interactionId,'--value',JSON.stringify(interaction.payload.values));
    await invoke('resume',id);
    assert.equal(calls.slice(start).filter(call=>call==='chat').length,processingMode==='combined'?1:2);
    assert.deepEqual((await unpack(directory)).map(card=>card.name).sort(),['apple','pear']);
}
async function unpack(directory) {
    const file=(await walk(path.join(workspace,directory))).find(file=>file.endsWith('deck.apkg'));
    assert.ok(file);
    const output=path.join(workspace,`${directory}-unpacked`);
    await promisify(execFile)(binary,['pkg2md',file,'--output',output]);
    return JSON.parse(await readFile(path.join(output,'cards.json'),'utf8'));
}
async function seed() {
    for(const [id,operation,output] of [['text','chat','text'],['vision','chat','text'],['image','image.generate','image'],['speech','speech.synthesize','audio']]) {
        const model={id:`fixture-${id}`,name:id,category:operation==='chat'?'chat':output,supportsVision:id==='vision',supportsTools:true,supportsStructuredOutput:true};
        const provider={id,name:id,implementation:'openai-compatible',baseURL:endpoint,apiKey:'fixture-key',enabled:true,models:[model]};
        if(operation!=='chat') {
            provider.media={[operation]:{adapter:id==='image'?'openai-images':'openai-speech'}};
            model.operations={[operation]:{inputModalities:['text'],outputModalities:[output],formats:[id==='image'?'png':'mp3'],...(id==='speech'?{voices:['fixture-voice']}:{})}};
        }
        await save(`etc/llm/.providers/${id}.json`,provider);
        await save(`etc/llm/.connections/${id}.json`,{id,name:id,providerId:id,enabled:true,protocol:'openai-chat',tiers:{optimal:model.id,standard:model.id}});
    }
}
async function save(relative,value) {
    const target=path.join(workspace,relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(value));return target;
}
async function invoke(...args) {
    try { return await promisify(execFile)(process.execPath,[...cli,...args,'--profile',workspace,'--state-dir',workspace,'--headless','--json'],{
        cwd:workspace,timeout:180000,maxBuffer:32000000,env:{...process.env,ANKI_CLI_BIN:binary,MINDOS_TOOL_MODULES:JSON.stringify([path.join(repo,'tools/anki-cli/node/extension.mjs')]),XDG_CONFIG_HOME:path.join(workspace,'xdg'),MINDOS_LOG_DIR:path.join(workspace,'logs')},
    }); } catch(error) {
        if(error.code===3 && error.stderr?.includes('run.waiting')) return {stdout:error.stdout,stderr:error.stderr};
        throw new Error(`${error.message}\n${error.stderr}\n${error.stdout}\nworkspace=${workspace}`);
    }
}
async function walk(root) {
    const files=[];for(const item of await readdir(root,{withFileTypes:true})){const full=path.join(root,item.name);if(item.isDirectory())files.push(...await walk(full));else files.push(full);}return files;
}
