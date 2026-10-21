export {};

declare global {
  interface Window {
    adeDesktop?: { chooseFolder: () => Promise<string | null> };
  }
}
