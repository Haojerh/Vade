export {};

declare global {
  interface Window {
    adeDesktop?: {
      customTitleBar: boolean;
      chooseFolder: () => Promise<string | null>;
      setNotifications: (settings: { enabled: boolean; sound: boolean }) => Promise<void>;
      onAgentNotification: (callback: (event: { item: import('../../shared/contracts').InboxItem; open: boolean }) => void) => () => void;
    };
  }
}
