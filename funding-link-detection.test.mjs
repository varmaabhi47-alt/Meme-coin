import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeFundingLinks} from './funding-link-detection.mjs';

test('flags direct known-risk funder and tracked-wallet funding',()=>{
  const result=analyzeFundingLinks(['walletA','walletB'],new Map([['walletA','bad'],['walletB','walletA']]),{knownRiskAddresses:new Set(['bad']),trackedAddresses:new Set(['walletA'])});
  assert.ok(result.get('walletA').reasons.includes('known-risk-funding-ancestor'));
  assert.ok(result.get('walletB').reasons.includes('funding-linked-to-tracked-wallet'));
});
test('flags two candidate wallets sharing a funding ancestor and assigns cluster id',()=>{
  const result=analyzeFundingLinks(['A','B'],new Map([['A','F'],['B','F']]));
  assert.ok(result.get('A').reasons.includes('shared-funding-cluster'));
  assert.equal(result.get('A').correlationGroup,'F');
  assert.equal(result.get('B').correlationGroup,'F');
});
test('walks up to two funding hops but respects depth bound',()=>{
  const graph=new Map([['A','B'],['B','RISK']]);
  const shallow=analyzeFundingLinks(['A'],graph,{knownRiskAddresses:new Set(['RISK']),maxDepth:1});
  const deep=analyzeFundingLinks(['A'],graph,{knownRiskAddresses:new Set(['RISK']),maxDepth:2});
  assert.equal(shallow.get('A').linked,false);
  assert.equal(deep.get('A').linked,true);
});
test('does not flag isolated wallets with no known or shared source',()=>{
  const result=analyzeFundingLinks(['A','B'],new Map([['A','X'],['B','Y']]));
  assert.equal(result.get('A').linked,false);assert.equal(result.get('B').linked,false);
});
