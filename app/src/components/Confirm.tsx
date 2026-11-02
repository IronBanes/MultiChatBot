// In-app confirmation dialog. window.confirm() isn't reliable inside a Tauri
// webview (on iOS it may not show at all and silently answer "no").

import { create } from "zustand";
import { Button, Modal } from "./ui";

interface Request {
  title: string;
  message: string;
  action: string;
  resolve: (ok: boolean) => void;
}

const useConfirm = create<{ req: Request | null }>(() => ({ req: null }));

/** Asks the user to confirm a destructive action; resolves false on cancel. */
export function confirmAction(title: string, message: string, action: string): Promise<boolean> {
  useConfirm.getState().req?.resolve(false);
  return new Promise((resolve) => useConfirm.setState({ req: { title, message, action, resolve } }));
}

export function ConfirmHost() {
  const req = useConfirm((s) => s.req);
  if (!req) return null;
  const answer = (ok: boolean) => {
    useConfirm.setState({ req: null });
    req.resolve(ok);
  };
  return (
    <Modal title={req.title} onClose={() => answer(false)}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{req.message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => answer(false)}>
          Cancel
        </Button>
        <Button className="!bg-red-600 hover:!bg-red-500" onClick={() => answer(true)} autoFocus>
          {req.action}
        </Button>
      </div>
    </Modal>
  );
}
