import test from 'node:test';
import assert from 'node:assert/strict';
import {selectWinningResearchMints} from './research-mint-source.mjs';
const research=[{chainId:'solana',token:'MINT_A',pairAddress:'PAIR_A',security:{pass:true}},{chainId:'solana',token:'MINT_B',pairAddress:'PAIR_B',security:{pass:true}},{chainId:'solana',token:'MINT_C',pairAddress:'PAIR_C',security:{pass:false}}];
test('selects only individually profitable listed mints with enough closed paper trades',()=>{
 const trades=Array.from({length:5},(_,i)=>({chainId:'solana',address:'MINT_A',netPnlUsd:2})).concat(Array.from({length:5},(_,i)=>({chainId:'solana',address:'MINT_B',netPnlUsd:-1})),Array.from({length:10},()=>({chainId:'solana',address:'MINT_C',netPnlUsd:10})));
 assert.deepEqual(selectWinningResearchMints(research,trades),['MINT_A']);
});
test('does not use unrelated aggregate portfolio PnL or insufficient samples',()=>{
 const rows=[{chainId:'solana',token:'MINT_A',pairAddress:'PAIR_A',security:{pass:true},paperLearning:{totalPnlUsd:999,sampleSize:100}}];
 assert.deepEqual(selectWinningResearchMints(rows,[{chainId:'solana',address:'MINT_A',netPnlUsd:10}]),[]);
});
test('missing security or pair listing fails closed',()=>{
 assert.deepEqual(selectWinningResearchMints([{chainId:'solana',token:'M',security:{pass:true}}],[{chainId:'solana',address:'M',netPnlUsd:1}]),[]);
});

import {selectRecentPassingResearchMints} from './research-mint-source.mjs';
test('recent passing research fallback uses only fresh checked RESEARCH mints and caps discovery',()=>{
 const now=Date.parse('2026-11-25T12:00:00Z');
 const rows=[
  {chainId:'solana',token:'FRESH_A',pairAddress:'PAIR_A',recordedAt:'2026-11-25T11:00:00Z',decision:'RESEARCH',security:{pass:true,checked:true}},
  {chainId:'solana',token:'FRESH_A',pairAddress:'PAIR_A',recordedAt:'2026-11-25T11:30:00Z',decision:'RESEARCH',security:{pass:true,checked:true}},
  {chainId:'solana',token:'FRESH_B',pairAddress:'PAIR_B',recordedAt:'2026-11-24T11:00:00Z',decision:'RESEARCH',security:{pass:true,checked:true}},
  {chainId:'solana',token:'WATCH',pairAddress:'PAIR_W',recordedAt:'2026-11-25T11:00:00Z',decision:'WATCH',security:{pass:true,checked:true}},
  {chainId:'solana',token:'UNCHECKED',pairAddress:'PAIR_U',recordedAt:'2026-11-25T11:00:00Z',decision:'RESEARCH',security:{pass:true,checked:false}},
  {chainId:'solana',token:'OLD',pairAddress:'PAIR_O',recordedAt:'2026-11-01T11:00:00Z',decision:'RESEARCH',security:{pass:true,checked:true}}
 ];
 assert.deepEqual(selectRecentPassingResearchMints(rows,{now,maxAgeMs:7*86400000,maxMints:1}),['FRESH_A']);
 assert.deepEqual(selectRecentPassingResearchMints(rows,{now,maxAgeMs:7*86400000,maxMints:3}),['FRESH_A','FRESH_B']);
});
