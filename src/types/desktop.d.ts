export {};

declare global {
  interface Window {
    adeDesktop?: { customTitleBar: boolean; chooseFolder: () => Promise<string | null> };
  }
}
