export {};

declare global {
  interface Window {
    adeDesktop?: {
      customTitleBar: boolean;
      phoneStatus: () => Promise<import('../../shared/contracts').PhoneConnectionSettings>;
      setupPhone: () => Promise<import('../../shared/contracts').PhoneSetupTerminal>;
      closePhoneSetup: (owner: { projectId: string; nodeId: string }) => Promise<void>;
      detectPhone: () => Promise<string | null>;
      savePhone: (value: import('../../shared/contracts').PhoneConnectionSettings) => Promise<import('../../shared/contracts').PhoneConnectionSettings>;
      setTheme: (theme: 'dark' | 'light') => Promise<void>;
      updateStatus: () => Promise<import('../../shared/contracts').DesktopUpdateStatus>;
      checkForUpdates: () => Promise<import('../../shared/contracts').DesktopUpdateStatus>;
      updateAndRestart: () => Promise<import('../../shared/contracts').DesktopUpdateStatus>;
      onUpdateStatus: (callback: (status: import('../../shared/contracts').DesktopUpdateStatus) => void) => () => void;
      chooseFolder: () => Promise<string | null>;
      setNotifications: (settings: { enabled: boolean; sound: boolean }) => Promise<void>;
      onAgentNotification: (callback: (event: { item: import('../../shared/contracts').InboxItem; open: boolean }) => void) => () => void;
    };
  }
}
