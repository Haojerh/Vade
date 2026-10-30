import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ConversationRewind} from '../features/workflow/chat/ConversationRewind';
import {UserMessageMeta} from '../features/workflow/chat/ResponseActions';
import {permissionPresentation} from '../features/workflow/chat/permissionPresentation';
import type {ConversationMessage,ConversationPage} from '../../shared/contracts';

test('rewind is visible only for a verified public user boundary in a capable source',()=>{
  const message:ConversationMessage={id:'msg-one',role:'user',text:'Edit this',at:null,rewindable:true};
  const page:ConversationPage={messages:[message],source:'transcript',sourceIdentity:'src-exact',revision:'rev-exact',provider:'dsh',cursor:null,nextCursor:null,limited:false,truncated:false,warnings:[]};
  const render=(overrides:Partial<ConversationPage>={},item=message,disabled=false)=>renderToStaticMarkup(createElement(ConversationRewind,{projectId:'project',nodeId:'node',page:{...page,...overrides},disabled,onRewound:()=>{},onNativeRewind:()=>{},children:createElement(UserMessageMeta,{message:item})}));
  assert.match(render(),/Rewind to this message/);
  assert.match(render({provider:'codex'}),/Rewind to this message/,'provider support comes from the verified message capability');
  assert.doesNotMatch(render({revision:undefined}),/Rewind to this message/);
  assert.doesNotMatch(render({}, {...message,rewindable:false}),/Rewind to this message/);
  assert.doesNotMatch(render({}, {...message,role:'agent'}),/Rewind to this message/);
  assert.match(render({},message,true),/aria-label="Rewind to this message" disabled=""/);
  for(const provider of ['antigravity','codebuddy']){
    assert.match(render({provider,revision:undefined},{...message,rewindable:false}),/Choose a rewind point in Terminal/);
    assert.doesNotMatch(render({provider}),/native-rewind-dialog/);
  }
});

test('permission presentation uses readable labels and distinct colors without guessing custom policies',()=>{
  const present=(value:string)=>permissionPresentation({value,label:value});
  assert.equal(present('read-only').label,'Read only');assert.equal(present('workspace-write').label,'Workspace access');assert.equal(present('danger-full-access').label,'Full access');
  assert.equal(present('read-only').tone,'read');assert.equal(present('workspace-write').tone,'workspace');assert.equal(present('danger-full-access').tone,'full');assert.equal(present('auto').tone,'auto');
  const custom=permissionPresentation({value:'custom-danger-policy',label:'Team policy',description:'Native description'});
  assert.equal(custom.label,'Team policy');assert.equal(custom.description,'Native description');assert.equal(custom.tone,'neutral');
});
