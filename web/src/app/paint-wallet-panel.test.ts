// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
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
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();});
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
  expect(t.host.querySelector("[data-buy-cta]")?.getAttribute("href")).toMatch(/near\.com\/?$/);
  expect(t.host.querySelector("[data-buy-cta]")?.textContent).toMatch(/Buy NEAR/);
 }
 finally{dispose();t.host.remove();}
});
it("refreshes on return and never disguises failure as zero",async()=>{
 const t=setup();const load=vi.fn().mockResolvedValueOnce(snapshot("12")).mockRejectedValue(new Error());const dispose=mountPaintWalletPanel(t.host,t.services,load,"mainnet");
 try{await tick();window.dispatchEvent(new Event("focus"));await tick();expect(t.host.querySelector('[data-value="credits"]')?.textContent).toBe("Unavailable — retry");}
 finally{dispose();t.host.remove();}
});
it("renders balances in credits and tiles vocabulary, with no raw pixel wording",async()=>{
 const t=setup();
 const load=vi.fn(async():Promise<PaintWalletSnapshot>=>({price:"0.0025 NEAR",credits:"4 credits",near:"1.0654 NEAR",mpoo:"",note:""}));
 const dispose=mountPaintWalletPanel(t.host,t.services,load,"mainnet");
 try{
  await tick();
  const rows=[...t.host.querySelectorAll(".paint-wallet-values > div")].map(row=>`${row.querySelector("dt")?.textContent} ${row.querySelector("dd")?.textContent}`);
  expect(rows[0]).toBe("Paint credits 4 credits");
  expect(rows[1]).toBe("NEAR in your wallet 1.0654 NEAR");
  expect(t.host.textContent).not.toMatch(/pixel/i);
  expect(t.host.textContent).toContain("Price per credit");
  expect(t.host.querySelector(".paint-wallet-status")?.textContent).toBe("Updated just now");
  // The panel describes the player's state, not itself.
  expect(t.host.textContent).not.toContain("This panel only shows balances");
 }
 finally{dispose();t.host.remove();}
});
it("has no mPOO row when the board is not selling for mPOO",async()=>{
 const t=setup();
 const dispose=mountPaintWalletPanel(t.host,t.services,async():Promise<PaintWalletSnapshot>=>({price:"0.0025 NEAR",credits:"4 credits",near:"1 NEAR",mpoo:"mPOO payments not enabled yet",note:""}),"mainnet");
 try{await tick();expect(t.host.querySelector<HTMLElement>("[data-row=mpoo]")!.hidden).toBe(true);}
 finally{dispose();t.host.remove();}
});
it("Buy credits presses the wall's own trigger from inside the panel",async()=>{
 const t=setup();
 const trigger=document.createElement("button");trigger.id="buy-credits-button";
 const clicked=vi.fn();trigger.addEventListener("click",clicked);
 document.body.append(trigger);
 const details=document.createElement("details");details.open=true;details.append(t.host);document.body.append(details);
 const dispose=mountPaintWalletPanel(t.host,t.services,async()=>snapshot("4 credits"),"mainnet");
 try{
  await tick();
  const buy=t.host.querySelector<HTMLAnchorElement>("[data-buy-credits]")!;
  expect(buy.textContent).toBe("Buy credits");
  expect(buy.getAttribute("href")).toBe("/wall");
  buy.click();
  expect(clicked).toHaveBeenCalledTimes(1);
  // The sheet needs the panel out of the way.
  expect(details.open).toBe(false);
  expect(buy.getAttribute("href")).toBe("/wall");
 }
 finally{dispose();details.remove();trigger.remove();}
});
