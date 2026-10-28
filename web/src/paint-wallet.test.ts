import { it, expect } from "vitest";
import { availableNear, formatUnits, loadPaintWallet, type Rpc } from "./paint-wallet";
const encoded = (value: unknown) => ({result: Array.from(new TextEncoder().encode(JSON.stringify(value)))});
function fixture(overrides: Record<string, unknown> = {}): Rpc {
 return async (method, params) => {
 const name = String(params.method_name ?? params.request_type ?? method);
 if (name in overrides) { if (overrides[name] instanceof Error) throw overrides[name]; return encoded(overrides[name]); }
 if (name === "view_account") return {amount:"1000000000000000000000000",locked:"0",storage_usage:100,block_hash:"block"};
 if (method === "EXPERIMENTAL_protocol_config") return {runtime_config:{storage_amount_per_byte:"10000000000000000000"}};
 return encoded(({get_board:{schema_version:4}, get_payment_config:{mpoo_token:"mpoo.nearlytrade.near",near_per_credit:"6900000000000000000000",mpoo_per_credit:"1000000000000000000"}, get_credits:"12",ft_metadata:{decimals:18},ft_balance_of:"12345678901234567890123456789"} as Record<string,unknown>)[name]);
 };
}
it("formats amounts without precision loss", () => {
 expect(formatUnits("12345678901234567890123456789",18)).toBe("12345678901.234567890123456789");
 expect(formatUnits("6900000000000000000000",24)).toBe("0.0069"); expect(() => formatUnits("-1",18)).toThrow();
});
it("subtracts storage without double subtracting locked funds", () => {
 expect(availableNear("1000000000000000000000000","0",100,"10000000000000000000")).toBe("0.999");
 expect(availableNear("1000000000000000000000000","1000000000000000000000000",100,"10000000000000000000")).toBe("1");
});
it("reads independent prices, credits and wallet balances",async () => {
 const data=await loadPaintWallet(fixture(),"board.near","mainnet","alice.near");
 expect(data.price).toBe("0.0069 NEAR / pixel · 1 mPOO / pixel"); expect(data.credits).toBe("12 pixels"); expect(data.near).toBe("0.999 NEAR");
 expect(data.mpoo).toContain("12345678901.234567890123456789");
});
it("distinguishes unregistered from failed reads",async () => {
 expect((await loadPaintWallet(fixture({get_credits:null}),"board.near","mainnet","a.near")).credits).toContain("Not registered");
 const data=await loadPaintWallet(fixture({get_credits:new Error()}),"board.near","mainnet","a.near");
 expect(data.credits).toBe("Unavailable — retry"); expect(data.near).toBe("0.999 NEAR");
});
it("never invents live credits for free or unconfigured boards",async () => {
 const free=await loadPaintWallet(fixture({get_board:{schema_version:2}}),"board.near","mainnet","a.near");
 expect(free.price).toContain("Planned"); expect(free.credits).toContain("not available");
 const empty=await loadPaintWallet(fixture(),"","testnet",null); expect(empty.near).toContain("Connect"); expect(empty.mpoo).toContain("No mPOO token");
});
it("rejects wrong mainnet tokens and invalid metadata",async () => {
 expect((await loadPaintWallet(fixture({get_payment_config:{mpoo_token:"fake.near"}}),"board.near","mainnet","a.near")).price).toBe("Unavailable — retry");
 expect((await loadPaintWallet(fixture({ft_metadata:{decimals:-1}}),"board.near","mainnet","a.near")).mpoo).toBe("Unavailable — retry");
});
