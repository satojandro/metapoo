// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn(), accounts: vi.fn(), selected: vi.fn(), wallet: vi.fn() }));
vi.mock("@hot-labs/near-connect", () => ({ NearConnector: vi.fn(() => ({
  on: vi.fn(), getConnectedWallet: mocks.selected, wallet: mocks.wallet,
})) }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
async function setup(id="meteor-wallet") {
  const wallet={ manifest:{id}, getAccounts:mocks.accounts, signAndSendTransaction:mocks.send };
  mocks.accounts.mockResolvedValue([{accountId:"owner.testnet"}]);
  mocks.selected.mockResolvedValue({wallet,accounts:[{accountId:"owner.testnet"}]});
  mocks.wallet.mockResolvedValue(wallet);
  const module=await import("./wallet"); await module.restoreWalletSession(); return module;
}
it("sends owner methods through the wallet with one yocto and no session key", async () => {
  const {signAndSendAdminChange}=await setup();
  await signAndSendAdminChange({contractId:"board.testnet",owner:"owner.testnet",methodName:"set_paused",args:{paused:true}});
  expect(mocks.send).toHaveBeenCalledWith({receiverId:"board.testnet",actions:[{type:"FunctionCall",params:{methodName:"set_paused",args:{paused:true},gas:"50000000000000",deposit:"1"}}]});
});
it("gives Meteor exact bytes when history cannot survive a JS number round-trip", async () => {
  const {signAndSendAdminChange}=await setup();
  await signAndSendAdminChange({contractId:"board.testnet",owner:"owner.testnet",methodName:"set_tunables",args:{tunables:{last_near_price_change_ns:1700000000123456789n,reserve_floor:"5000000000000000000000000"}}});
  const args=mocks.send.mock.calls[0][0].actions[0].params.args;
  expect(args).toBeInstanceOf(Uint8Array);
  expect(new TextDecoder().decode(args)).toBe('{"tunables":{"last_near_price_change_ns":1700000000123456789,"reserve_floor":"5000000000000000000000000"}}');
});
it("refuses unsafe settings serialization through an unverified wallet adapter", async () => {
  const {signAndSendAdminChange}=await setup("another-wallet");
  await expect(signAndSendAdminChange({contractId:"board.testnet",owner:"owner.testnet",methodName:"set_tunables",args:{history:1700000000123456789n}})).rejects.toThrow("ExactSettingsWalletRequired");
  expect(mocks.send).not.toHaveBeenCalled();
});
it("rechecks the actual wallet account before signing", async () => {
  const {signAndSendAdminChange}=await setup(); mocks.accounts.mockResolvedValue([{accountId:"someone.testnet"}]);
  await expect(signAndSendAdminChange({contractId:"board.testnet",owner:"owner.testnet",methodName:"set_paused",args:{paused:true}})).rejects.toThrow("OwnerWalletRequired");
  expect(mocks.send).not.toHaveBeenCalled();
});
