/**
 * The one way into a wallet.
 *
 * The shell owns a single Connect control (`#connect-button`): it opens the wallet
 * picker and carries the drawing-key opt-in (`shell.ts`). A panel whose primary
 * action is blocked only because nobody is signed in should say "Connect wallet"
 * and press that control, rather than render a dead button that tells the player
 * what they cannot do (UI review C1).
 *
 * The fallback exists for tests and for any surface mounted without the shell.
 */
export function connectWallet(fallback?: () => void): void {
  const button = document.querySelector<HTMLButtonElement>("#connect-button");
  if (button) {
    button.click();
    return;
  }
  fallback?.();
}
