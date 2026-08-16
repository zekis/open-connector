import type { FormEvent, ReactNode } from "react";

import { Check, Copy, Loader2, Plus, QrCode, ShieldCheck, Smartphone, Trash2, Wifi } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "react-qr-code";
import { apiDelete, apiGet, apiPost } from "./api";
import oomolConnectLogoUrl from "./assets/oomol-connect-logo.png";
import { InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface MobileDevice {
  id: string;
  pairingId: string;
  name: string;
  userAgent?: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface MobilePairingCreation {
  code: string;
  pairing: {
    id: string;
    name: string;
    createdAt: string;
    expiresAt: string;
  };
}

export function MobileConnectionPage(): ReactNode {
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [pairingOpen, setPairingOpen] = useState(false);
  const [deviceName, setDeviceName] = useState("My phone");
  const [pairing, setPairing] = useState<MobilePairingCreation>();
  const [copied, setCopied] = useState(false);
  const pairedDevice = pairing ? devices.find((device) => device.pairingId === pairing.pairing.id) : undefined;
  const pairingUrl = useMemo(
    () => (pairing ? `${window.location.origin}/mobile-connect#code=${encodeURIComponent(pairing.code)}` : undefined),
    [pairing],
  );

  const loadDevices = useCallback(async (): Promise<void> => {
    try {
      setDevices(await apiGet<MobileDevice[]>("/api/mobile-devices"));
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load mobile devices.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    if (!pairing || pairedDevice) return;
    const interval = window.setInterval(() => void loadDevices(), 2_000);
    return () => window.clearInterval(interval);
  }, [loadDevices, pairedDevice, pairing]);

  async function createPairing(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy("create");
    setError(undefined);
    try {
      setPairing(await apiPost<MobilePairingCreation>("/api/mobile-pairings", { name: deviceName.trim() }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the mobile connection.");
    } finally {
      setBusy(undefined);
    }
  }

  async function closePairing(): Promise<void> {
    const current = pairing;
    setPairingOpen(false);
    setPairing(undefined);
    setCopied(false);
    if (current && !pairedDevice) {
      await apiDelete(`/api/mobile-pairings/${encodeURIComponent(current.pairing.id)}`).catch(() => undefined);
    }
    if (pairedDevice) await loadDevices();
  }

  async function copyPairingLink(): Promise<void> {
    if (!pairingUrl) return;
    await navigator.clipboard.writeText(pairingUrl);
    setCopied(true);
  }

  async function revokeDevice(device: MobileDevice): Promise<void> {
    if (!window.confirm(`Remove mobile access for ${device.name}?`)) return;
    setBusy(device.id);
    setError(undefined);
    try {
      await apiDelete(`/api/mobile-devices/${encodeURIComponent(device.id)}`);
      await loadDevices();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the mobile device.");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="mobile-page">
      <div className="mobile-hero">
        <div>
          <span className="mobile-kicker">
            <Smartphone size={15} /> Persistent browser access
          </span>
          <h2>Open OOMOL Connect on your phone</h2>
          <p>
            Scan once to connect a mobile browser without entering the admin token. Access stays active until you remove
            that device here.
          </p>
        </div>
        <Button
          onClick={() => {
            setPairingOpen(true);
            setPairing(undefined);
            setCopied(false);
          }}
        >
          <Plus size={16} /> Connect phone
        </Button>
      </div>

      <div className="mobile-security-note">
        <ShieldCheck size={19} />
        <div>
          <strong>Revocable device access</strong>
          <span>
            The QR is single-use and expires after 10 minutes. Connected-device credentials are stored hashed.
          </span>
        </div>
      </div>

      {error ? <InlineError message={error} /> : null}

      <div className="mobile-section-heading">
        <div>
          <h3>Connected mobile browsers</h3>
          <p>Removing a device immediately signs that browser out.</p>
        </div>
        <span>{devices.length}</span>
      </div>

      {loading ? (
        <div className="mobile-empty">
          <Loader2 className="spin" size={20} /> Loading mobile devices…
        </div>
      ) : devices.length === 0 ? (
        <div className="mobile-empty">
          <Smartphone size={28} />
          <strong>No phones connected</strong>
          <span>Create a QR code to connect your first mobile browser.</span>
        </div>
      ) : (
        <div className="mobile-device-list">
          {devices.map((device) => (
            <article className="mobile-device-card" key={device.id}>
              <div className="mobile-device-icon">
                <Smartphone size={22} />
                <span />
              </div>
              <div className="mobile-device-copy">
                <strong>{device.name}</strong>
                <span>{describeMobileBrowser(device.userAgent)}</span>
                <small>
                  Connected {formatDateTime(device.createdAt)} · Last used {formatDateTime(device.lastUsedAt)}
                </small>
              </div>
              <Button
                variant="outline"
                size="icon"
                disabled={busy === device.id}
                aria-label={`Remove ${device.name}`}
                title={`Remove ${device.name}`}
                onClick={() => void revokeDevice(device)}
              >
                {busy === device.id ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
              </Button>
            </article>
          ))}
        </div>
      )}

      <Dialog open={pairingOpen} onOpenChange={(open) => (open ? setPairingOpen(true) : void closePairing())}>
        <DialogContent className="mobile-pairing-dialog">
          <DialogHeader>
            <DialogTitle>{pairing ? "Scan with your phone" : "Connect a mobile browser"}</DialogTitle>
            <DialogDescription>
              {pairing
                ? "Open your camera, scan the QR code, then confirm this device appears as connected."
                : "Give this browser a recognizable name before creating its one-time QR code."}
            </DialogDescription>
          </DialogHeader>

          {!pairing ? (
            <form className="mobile-pairing-form" onSubmit={(event) => void createPairing(event)}>
              <Label className="field">
                <span>Device name</span>
                <Input
                  value={deviceName}
                  maxLength={80}
                  autoFocus
                  placeholder="My phone"
                  onChange={(event) => setDeviceName(event.target.value)}
                />
              </Label>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => void closePairing()}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy === "create"}>
                  {busy === "create" ? <Loader2 className="spin" size={15} /> : <QrCode size={15} />} Create QR code
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="mobile-qr-stage">
              <div className={pairedDevice ? "mobile-qr-frame connected" : "mobile-qr-frame"}>
                {pairedDevice ? (
                  <div className="mobile-qr-success">
                    <Check size={34} />
                    <strong>{pairedDevice.name} connected</strong>
                    <span>The mobile browser can now open OOMOL Connect without logging in.</span>
                  </div>
                ) : (
                  <QRCode value={pairingUrl!} size={226} level="M" bgColor="#ffffff" fgColor="#101114" />
                )}
              </div>
              {!pairedDevice ? (
                <>
                  <span className="mobile-pairing-expiry">
                    <Wifi size={14} /> Expires {formatDateTime(pairing.pairing.expiresAt)}
                  </span>
                  <Button variant="outline" onClick={() => void copyPairingLink()}>
                    {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Link copied" : "Copy link"}
                  </Button>
                </>
              ) : null}
              <Button onClick={() => void closePairing()}>{pairedDevice ? "Done" : "Close"}</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function MobileConnectLanding(): ReactNode {
  const [state, setState] = useState<"connecting" | "connected" | "failed">("connecting");
  const [message, setMessage] = useState("Authorizing this mobile browser…");

  useEffect(() => {
    const code = new URLSearchParams(window.location.hash.slice(1)).get("code")?.trim();
    window.history.replaceState(null, "", "/mobile-connect");
    if (!code) {
      setState("failed");
      setMessage("This mobile connection link is incomplete. Create a new QR code from the desktop site.");
      return;
    }

    let cancelled = false;
    let redirect: number | undefined;
    void apiPost<{ connected: true }>("/api/mobile-auth/exchange", { code })
      .then(() => {
        if (cancelled) return;
        setState("connected");
        setMessage("Connected. Opening your feed…");
        redirect = window.setTimeout(() => window.location.replace("/feed"), 700);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setState("failed");
        setMessage(
          caught instanceof Error
            ? caught.message
            : "This mobile connection has expired or was already used. Create a new QR code.",
        );
      });
    return () => {
      cancelled = true;
      if (redirect !== undefined) window.clearTimeout(redirect);
    };
  }, []);

  return (
    <main className="mobile-connect-screen">
      <section className={`mobile-connect-panel ${state}`}>
        <img className="brand-mark" src={oomolConnectLogoUrl} alt="" />
        <div className="mobile-connect-state">
          {state === "connecting" ? (
            <Loader2 className="spin" size={28} />
          ) : state === "connected" ? (
            <Check size={28} />
          ) : (
            <QrCode size={28} />
          )}
        </div>
        <h1>{state === "failed" ? "Could not connect" : "OOMOL Connect mobile"}</h1>
        <p>{message}</p>
        {state === "failed" ? (
          <Button variant="outline" onClick={() => window.location.replace("/")}>
            Open sign in
          </Button>
        ) : null}
      </section>
    </main>
  );
}

export function describeMobileBrowser(userAgent: string | undefined): string {
  if (!userAgent) return "Mobile browser";
  const device = /iPhone/i.test(userAgent)
    ? "iPhone"
    : /iPad/i.test(userAgent)
      ? "iPad"
      : /Android/i.test(userAgent)
        ? "Android"
        : "Browser";
  const browser = /EdgA|EdgiOS/i.test(userAgent)
    ? "Edge"
    : /CriOS|Chrome/i.test(userAgent)
      ? "Chrome"
      : /FxiOS|Firefox/i.test(userAgent)
        ? "Firefox"
        : /Safari/i.test(userAgent)
          ? "Safari"
          : undefined;
  return browser ? `${device} · ${browser}` : device;
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
