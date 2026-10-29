// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { mountPaintWalletPanel } from "./paint-wallet-panel";
import { createOperationsStore } from "./operations";
import type { AppServices } from "./services";
import type { WalletSession } from "../wallet";
import type { PaintWalletSnapshot } from "../paint-wallet";
const snapshot=(s:string):PaintWalletSnapshot=>({price:s,credits:s,near:s,mpoo:s,note:s});
function setup(){
 let session:WalletSession={accountId:"alice.near",networkId:"mainnet"}; let listener=()=>{};
 const services:AppServices={wallet:{getSession:()=>session,connect:async()=>{},disconnect:async()=>{},subscribe:fn=>{listener=()=>fn(session);return ()=>{};},whenReady:Promise.resolve(session)},operations:createOperationsStore()};
 const host=document.createElement("section");document.body.append(host);
 return {host,services,change(next:WalletSession){session=next;listener();}};
}
const tick=async()=>{await Promise.resolve();await Promise.resolve();};
it("discards late responses from a previous wallet",async()=>{
 const t=setup();let resolve!:(v:PaintWalletSnapshot)=>void;const old=new Promise<PaintWalletSnapshot>(r=>{resolve=r;});
 const dispose=mountPaintWalletPanel(t.host,t.services,account=>account==="alice.near"?old:Promise.resolve(snapshot("Bob")),"mainnet");
 try {t.change({accountId:"bob.near",networkId:"mainnet"});await tick();resolve(snapshot("Alice"));await tick();expect(t.host.textContent).toContain("Bob");expect(t.host.textContent).not.toContain("Alice");}
 finally{dispose();t.host.remove();}
});
it("blocks network mismatches and offers Buy NEAR while mPOO is disabled",()=>{
 const t=setup();const load=vi.fn(async()=>snapshot("wrong"));const dispose=mountPaintWalletPanel(t.host,t.services,load,"testnet");
 try{
  expect(load).not.toHaveBeenCalled();
  expect(t.host.textContent).toContain("Switch wallet network");
  expect(t.host.textContent).not.toContain("Buy mPOO on NEARLY");
  expect(t.host.textContent).not.toContain("cannot fund testnet");
  expect(t.host.querySelector("[data-row=mpoo]")?.hasAttribute("hidden")).toBe(true);
  expect(t.host.querySelector("a")?.href).toMatch(/near\.org\/?$/);
  expect(t.host.querySelector("a")?.textContent).toMatch(/Buy NEAR/);
 }
 finally{dispose();t.host.remove();}
});
it("refreshes on return and never disguises failure as zero",async()=>{
 const t=setup();const load=vi.fn().mockResolvedValueOnce(snapshot("12")).mockRejectedValue(new Error());const dispose=mountPaintWalletPanel(t.host,t.services,load,"mainnet");
 try{await tick();window.dispatchEvent(new Event("focus"));await tick();expect(t.host.querySelector('[data-value="credits"]')?.textContent).toBe("Unavailable — retry");}
 finally{dispose();t.host.remove();}
});
