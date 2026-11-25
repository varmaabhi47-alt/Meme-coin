/**
 * Funding-link analysis over observed transfer edges.
 * Edges are evidence, not proof of common control; shared source clusters are
 * flagged for curator rejection/review, never silently promoted.
 */
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
export function analyzeFundingLinks(candidateAddresses, fundingSources, {
  knownRiskAddresses = new Set(), trackedAddresses = new Set(), sharedSourceMin = 2, maxDepth = 2
} = {}) {
  const candidates=new Set(candidateAddresses);
  const parents=new Map();
  for(const [wallet,sourceValue] of fundingSources instanceof Map ? fundingSources : Object.entries(fundingSources||{})) {
    parents.set(wallet,list(sourceValue).filter(x=>typeof x==='string'&&x&&x!==wallet));
  }
  const rootsByCandidate=new Map(),rootCounts=new Map();
  for(const address of candidates) {
    const roots=new Set(),queue=(parents.get(address)||[]).map(source=>({address:source,depth:1})),seen=new Set([address]);
    while(queue.length) {
      const node=queue.shift();if(seen.has(node.address))continue;seen.add(node.address);
      roots.add(node.address);
      if(node.depth<maxDepth)for(const parent of parents.get(node.address)||[])queue.push({address:parent,depth:node.depth+1});
    }
    rootsByCandidate.set(address,roots);
    for(const root of roots)rootCounts.set(root,(rootCounts.get(root)||0)+1);
  }
  const result=new Map();
  for(const address of candidates) {
    const roots=rootsByCandidate.get(address)||new Set(),reasons=[];
    if([...roots].some(root=>knownRiskAddresses.has(root)))reasons.push('known-risk-funding-ancestor');
    if([...roots].some(root=>trackedAddresses.has(root)))reasons.push('funding-linked-to-tracked-wallet');
    if([...roots].some(root=>(rootCounts.get(root)||0)>=sharedSourceMin))reasons.push('shared-funding-cluster');
    const immediate=(parents.get(address)||[])[0]||null;
    result.set(address,{linked:reasons.length>0,reasons,fundingSource:immediate,correlationGroup:immediate||''});
  }
  return result;
}
