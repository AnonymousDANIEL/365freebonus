import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const code=ts.transpileModule(readFileSync(new URL('../app/[adminPath]/AdminClient.tsx',import.meta.url),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
const flush=async()=>{for(let index=0;index<24;index++)await Promise.resolve();};
const features=[
  ['品牌通知','telegram','TelegramGroupSettings','notifications'],
  ['个人账号来源频道','telegramSources','TelegramGroupSettings','sources'],
  ['图片自动转发','telegramRelay','TelegramGroupSettings','relay'],
  ['文案定时','scheduledMessages','TelegramScheduledMessages'],
  ['Game Tips','gameTips','TelegramScheduledMessages'],
  ['Hot 视频定时','hotVideos','TelegramHotVideos'],
  ['聊天机器人','telegramChatbot','TelegramGroupSettings','chatbot'],
  ['关键词回复','telegramKeywords','TelegramGroupSettings','keywords'],
  ['1 对 1 私聊','telegramPrivate','TelegramGroupSettings','private'],
  ['私聊品牌更新','telegramUpdates','TelegramGroupSettings','updates'],
  ['未识别消息跟进','telegramFollowup','TelegramGroupSettings','followup'],
  ['入群审核','telegramJoinGate','TelegramGroupSettings','joinGate'],
];
const panelNames=['TelegramGroupSettings','TelegramScheduledMessages','TelegramHotVideos','PopupNoticeSettings','PasswordSettings','SecureNotes'];

// Render the actual navigation with controlled hooks and stub leaf panels. These
// tests exercise click handlers and rerenders without a login, browser or writes.
function harness(){
  const hooks=[],effects=[],calls=[];
  let cursor=0,tree,timer=0;
  const jsx=(type,props,key)=>({type,props:props||{},key});
  const react={
    useState(initial){const slot=cursor++;if(!hooks[slot])hooks[slot]={value:typeof initial==='function'?initial():initial};return[hooks[slot].value,value=>{hooks[slot].value=typeof value==='function'?value(hooks[slot].value):value;}];},
    useRef(initial){const slot=cursor++;if(!hooks[slot])hooks[slot]={current:initial};return hooks[slot];},
    useEffect(callback,deps){const slot=cursor++,previous=hooks[slot];if(!previous||deps.some((value,index)=>value!==previous.deps[index])){previous?.cleanup?.();effects.push(()=>{hooks[slot]={deps,cleanup:callback()};});}},
  };
  const settings={name:'Fixture directory',headline:'Find your favourite.',description:'Fixture description',announcement:'',contactUrl:''};
  const moduleObject={exports:{}};
  vm.runInNewContext(code,{module:moduleObject,exports:moduleObject.exports,require(name){
    if(name==='react')return react;
    if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:'fragment'};
    if(name==='lucide-react')return new Proxy({},{get:(_,key)=>`icon:${String(key)}`});
    if(name==='../components/AdminTheme')return{useAdminTheme:()=>({theme:'light',setTheme(){}}),AdminThemeToggle:'test:AdminThemeToggle'};
    if(name==='../lib/directory')return{DEFAULT_PROMOTION_DAYS:7,effectiveBrandCategory:brand=>brand.category,isBrandPublished:brand=>Boolean(brand.published),isSafeSocialUrl:()=>true,isValidPromotionStart:()=>true};
    if(name==='../lib/image-url')return{isSafeImageUrl:()=>true,isUploadedImageUrl:()=>true};
    if(name==='../lib/brand-schedule-input')return{brandScheduleInput:()=>'',malaysiaDateTimeInput:()=>''};
    if(name.endsWith('.css'))return{};
    if(name.startsWith('./'))return{default:`test:${name.slice(2)}`};
    throw Error(`Unexpected import ${name}`);
  },Date,Error,Intl,AbortController,Blob,
    async fetch(url,options={}){calls.push({url,method:options.method||'GET'});return{ok:true,json:async()=>({brands:[],settings})};},
    setTimeout(){return ++timer;},clearTimeout(){},window:{setTimeout(){return ++timer;},clearTimeout(){},location:{assign(){throw Error('Unexpected navigation');}}},
  });
  function render(){cursor=0;tree=moduleObject.exports.default({displayName:'Fixture owner',signInPath:'/fixture-sign-in'});for(const effect of effects.splice(0))effect();return tree;}
  function nodes(node,found=[]){if(arguments.length===0)node=tree;if(node==null||typeof node!=='object')return found;if(Array.isArray(node)){node.forEach(child=>nodes(child,found));return found;}found.push(node);nodes(node.props?.children,found);return found;}
  function text(node){if(node==null||typeof node==='boolean')return'';if(typeof node!=='object')return String(node);if(Array.isArray(node))return node.map(text).join('');return text(node.props?.children);}
  function nav(){const value=nodes().find(node=>node.type==='nav'&&node.props['aria-label']==='后台导航');assert.ok(value);return value;}
  function group(){const value=nodes(nav()).find(node=>node.type==='button'&&node.props['aria-controls']==='cms-telegram-submenu');assert.ok(value,'Telegram disclosure button');return value;}
  function submenu(){const value=nodes(nav()).find(node=>node.props.id==='cms-telegram-submenu');assert.ok(value,'Telegram submenu');return value;}
  function navButton(label){const value=nodes(nav()).find(node=>node.type==='button'&&(text(node)===label||text(node).startsWith(`${label}0`)));assert.ok(value,`navigation ${label}`);return value;}
  function main(){return nodes().find(node=>node.type==='main');}
  function panels(){return nodes(main()).filter(node=>panelNames.includes(String(node.type).replace('test:','')));}
  function breadcrumb(){const value=nodes(main()).find(node=>node.props.className==='cms-breadcrumb');assert.ok(value);return text(value);}
  function click(node){node.props.onClick();render();}
  render();
  return{calls,render,nodes,text,nav,group,submenu,navButton,main,panels,breadcrumb,click,
    async ready(){await flush();render();},
    close(){for(const hook of hooks)hook?.cleanup?.();},
  };
}

test('Telegram disclosure groups every feature once and toggles accessible expansion without changing the current page',async()=>{
  const h=harness();try{
    await h.ready();
    assert.equal(h.group().props['aria-expanded'],false);assert.equal(h.submenu().props.hidden,true);
    const initial=h.breadcrumb();h.click(h.group());
    assert.equal(h.group().props['aria-expanded'],true);assert.equal(h.submenu().props.hidden,false);
    assert.equal(h.submenu().props.role,'group');assert.equal(h.submenu().props['aria-label'],'Telegram 功能');
    const children=h.nodes(h.submenu()).filter(node=>node.type==='button');
    assert.deepEqual(children.map(node=>h.text(node)),features.map(([label])=>label));
    for(const[label,key]of features){
      assert.equal(children.filter(node=>node.props['data-telegram-section']===key).length,1);
      assert.equal(h.nodes(h.nav()).filter(node=>node.type==='button'&&h.text(node)===label).length,1,`${label} must not be duplicated at the navigation root`);
    }
    h.click(h.group());assert.equal(h.group().props['aria-expanded'],false);assert.equal(h.submenu().props.hidden,true);
    assert.equal(h.breadcrumb(),initial);assert.equal(h.panels().length,0);
  }finally{h.close();}
});

test('each Telegram child selects only its own panel and synchronizes active state, heading and breadcrumb',async()=>{
  const h=harness();try{
    await h.ready();h.click(h.group());
    for(const[label,key,panel,view]of features){
      h.click(h.navButton(label));
      const panels=h.panels();assert.equal(panels.length,1,label);assert.equal(panels[0].type,`test:${panel}`,label);
      assert.equal(panels[0].props.signInPath,'/fixture-sign-in');assert.equal(typeof panels[0].props.request,'function');
      if(view)assert.equal(panels[0].props.view,view,label);
      if(panel==='TelegramScheduledMessages'){
        assert.equal(panels[0].props.workspace,key==='gameTips'?'gameTips':'messages');
        assert.equal(panels[0].key,key);
      }
      const selected=h.nodes(h.nav()).filter(node=>node.type==='button'&&node.props['aria-current']==='page');
      assert.equal(selected.length,1);assert.equal(selected[0].props['data-telegram-section'],key);
      assert.match(selected[0].props.className,/active/);
      assert.ok(h.breadcrumb().includes('Telegram 通知'));assert.ok(h.breadcrumb().includes(label));
      assert.ok(h.text(h.nodes(h.main()).find(node=>node.type==='h1')).startsWith(label));
    }
    const selectedPanel=h.panels()[0];h.click(h.group());
    assert.equal(h.submenu().props.hidden,true);assert.equal(h.panels()[0].type,selectedPanel.type);assert.equal(h.panels()[0].props.view,selectedPanel.props.view);
    assert.ok(h.calls.every(call=>call.method==='GET'),'navigation must not mutate settings or trigger sends');
  }finally{h.close();}
});

test('brand, website, announcement and security roots remain independently reachable',async()=>{
  const h=harness();try{
    await h.ready();h.click(h.group());h.click(h.navButton('文案定时'));
    for(const[label,panel,selector]of[
      ['品牌管理',null,node=>node.props['aria-label']==='品牌统计'],
      ['网站设置',null,node=>node.props.className==='cms-settings-form'],
      ['弹窗公告','PopupNoticeSettings'],
      ['安全笔记','SecureNotes'],
      ['更改密码','PasswordSettings'],
    ]){
      h.click(h.navButton(label));
      assert.equal(h.breadcrumb().includes(label),true);assert.equal(h.breadcrumb().includes('Telegram 通知'),false);
      if(panel){assert.equal(h.panels().length,1);assert.equal(h.panels()[0].type,`test:${panel}`);}
      else{assert.equal(h.panels().length,0);assert.ok(h.nodes(h.main()).some(selector),`${label} content remains reachable`);}
      assert.equal(h.nodes(h.nav()).filter(node=>node.props['data-telegram-section']&&node.props['aria-current']==='page').length,0);
    }
    assert.ok(h.nodes(h.nav()).some(node=>node.type==='a'&&node.props.href==='/'&&h.text(node).includes('查看前台')));
    assert.ok(h.calls.every(call=>call.method==='GET'));
  }finally{h.close();}
});
