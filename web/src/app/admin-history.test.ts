import { afterEach, expect, it, vi } from "vitest";
import { loadAdminHistory } from "./admin-history";
afterEach(()=>vi.unstubAllGlobals());
it("shows only this board's validated admin transactions, preserving outcomes", async () => {
  const hash="1".repeat(44);
  const fetch=vi.fn(async (url: string) => ({ ok:true, json:async()=>({txns:[
    {transaction_hash:hash,receiver_account_id:"board.testnet",block_timestamp:"1793000000000123456",actions_agg:{method:"set_tunables"},outcomes:{status:false}},
    {transaction_hash:"2".repeat(44),receiver_account_id:"another.testnet",block_timestamp:"1793000000000123456",actions_agg:{method:"set_tunables"}},
    {transaction_hash:"3".repeat(44),receiver_account_id:"board.testnet",block_timestamp:"1793000000000123456",actions_agg:{method:"draw"}},
  ]}) }));
  vi.stubGlobal("fetch",fetch);
  expect(await loadAdminHistory("testnet","board.testnet")).toEqual([{hash,method:"set_tunables",timestampNs:1793000000000123456n,succeeded:false}]);
  expect(fetch).toHaveBeenCalledTimes(7);
});
it("reports a failed history request instead of inventing an empty history", async()=>{
  vi.stubGlobal("fetch",vi.fn(async()=>({ok:false,status:429})));
  await expect(loadAdminHistory("testnet","board.testnet")).rejects.toThrow("History HTTP 429");
});
