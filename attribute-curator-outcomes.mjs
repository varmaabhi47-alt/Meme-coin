#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {attributeWalletOutcomes,summarizeWalletOutcomes} from './curator-outcomes.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
async function readJson(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return fallback;}}
async function jsonl(file){const text=await fs.readFile(file,'utf8').catch(()=>''),rows=[];for(const line of text.split(/\r?\n/)){if(!line.trim())continue;try{rows.push(JSON.parse(line));}catch{}}return rows;}
async function main(){
  const buysDoc=await readJson(path.join(ROOT,'smart_wallet_buys.json'),{buys:[]});
  const buys=Array.isArray(buysDoc)?buysDoc:Array.isArray(buysDoc.buys)?buysDoc.buys:Array.isArray(buysDoc.results)?buysDoc.results:[];
  const research=await jsonl(path.join(ROOT,'paper_research.jsonl'));
  const outcomes=attributeWalletOutcomes(buys,research),summary=summarizeWalletOutcomes(outcomes);
  const dry=process.argv.includes('--dry-run');
  const output=outcomes.map(x=>JSON.stringify(x)).join('\n')+(outcomes.length?'\n':'');
  if(!dry)await fs.writeFile(path.join(ROOT,'paper_wallet_outcomes.jsonl'),output);
  console.log(JSON.stringify({mode:dry?'dry-run':'write',walletBuyEvents:buys.length,priceSnapshots:research.length,attributedBuyEvents:outcomes.length,wallets:summary.length,missingEntryPrices:outcomes.filter(x=>x.entryPriceUsd===null).length,outputFile:dry?null:'paper_wallet_outcomes.jsonl',sampleWallets:summary.slice(0,5)},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error('[outcome attribution]',e.message);process.exitCode=1;});
export {attributeWalletOutcomes,summarizeWalletOutcomes};
