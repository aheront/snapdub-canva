// Talking to SnapDub from inside Canva. Canva signs the person in against SnapDub's own OAuth server
// (the auth provider set up in the Developer Portal) and keeps and refreshes the tokens itself; the
// app only asks for the current access token. Every call goes to snapdub.ai/canva/mcp, which also
// wants Canva's user token so it knows the request came from this app (video-cutter's
// CanvaMcpController).
import { auth } from "@canva/user";

export const SNAPDUB_URL = "https://snapdub.ai";
const ENDPOINT = `${SNAPDUB_URL}/canva/mcp`;
const SCOPE = new Set(["mcp"]);

export const oauth = auth.initOauth();

export class SignedOut extends Error {}

export type Account = {
  account?: string;
  plan?: string;
  credits_left?: number;
  upgrade_url?: string;
};

export type Video = {
  video_id: string;
  title?: string;
  status?: string;
  progress_percent?: number;
  clips_ready?: number;
  created_at?: string;
};

export type Clip = {
  clip_id: string;
  title?: string;
  virality_score?: number;
  duration_seconds?: number;
  width?: number;
  height?: number;
  download_url?: string;
  thumbnail_url?: string;
};

export async function isSignedIn(): Promise<boolean> {
  return Boolean(await oauth.getAccessToken({ scope: SCOPE }));
}

// Opens SnapDub's sign-in page (log in or create an account) in Canva's own window.
export async function signIn(): Promise<boolean> {
  const response = await oauth.requestAuthorization({ scope: SCOPE });
  return response.status === "completed";
}

export async function signOut(): Promise<void> {
  await oauth.deauthorize();
}

let rpcId = 0;

async function callTool<T>(
  name: string,
  args: Record<string, unknown> = {},
  retried = false,
): Promise<T> {
  const access = await oauth.getAccessToken({
    scope: SCOPE,
    forceRefresh: retried,
  });
  if (!access) throw new SignedOut();

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access.token}`,
      "X-Canva-User-Token": await auth.getCanvaUserToken(),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (response.status === 401) {
    const body = await response.json().catch(() => ({}));
    // The SnapDub token, not Canva's: refresh once, then ask the person to sign in again.
    if (body.error === "invalid_token") {
      if (!retried) return callTool<T>(name, args, true);
      throw new SignedOut();
    }
    throw new Error("unauthorized");
  }
  if (response.status === 429) throw new Error("too_many_requests");
  if (!response.ok) throw new Error("server_error");

  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "server_error");
  const result = body.result || {};
  if (result.isError) {
    throw new Error(result.content?.[0]?.text || "server_error");
  }
  return (result.structuredContent ||
    JSON.parse(result.content?.[0]?.text || "{}")) as T;
}

export const whoami = () => callTool<Account>("whoami");

// One page of 20 videos, newest first; next_page is set while older ones remain. The first page is
// asked for with no arguments, the way every SnapDub version answers it.
export const listVideos = (page = 1) =>
  callTool<{ videos: Video[]; next_page?: number }>(
    "list_videos",
    page > 1 ? { page } : {},
  );

export const listClips = (videoId: string) =>
  callTool<{ clips: Clip[]; note?: string }>("list_clips", {
    video_id: videoId,
  });
