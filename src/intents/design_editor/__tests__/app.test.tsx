import { useFeatureSupport } from "@canva/app-hooks";
import { upload } from "@canva/asset";
import { addElementAtPoint } from "@canva/design";
import type { Feature, PlatformInfo } from "@canva/platform";
import { getPlatformInfo } from "@canva/platform";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { App } from "src/intents/design_editor/app";
import * as snapdub from "src/snapdub";
import { renderInTestProvider } from "src/utils/test_render";

jest.mock("@canva/app-hooks");
jest.mock("src/snapdub", () => {
  class SignedOut extends Error {}
  return {
    SNAPDUB_URL: "https://snapdub.ai",
    SignedOut,
    isSignedIn: jest.fn(),
    signIn: jest.fn(),
    signOut: jest.fn(),
    whoami: jest.fn(),
    listVideos: jest.fn(),
    listClips: jest.fn(),
  };
});

const api = jest.mocked(snapdub);

const clip = {
  clip_id: "c1",
  title: "The best moment",
  duration_seconds: 31,
  width: 1080,
  height: 1920,
  download_url: "https://media.snapdub.ai/c1.mp4",
  thumbnail_url: "https://media.snapdub.ai/c1.jpg",
};

describe("SnapDub panel", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest
      .mocked(useFeatureSupport)
      .mockReturnValue((fn: Feature) => fn === addElementAtPoint);
    jest
      .mocked(getPlatformInfo)
      .mockReturnValue({ canAcceptPayments: true } as PlatformInfo);
    api.whoami.mockResolvedValue({ plan: "Free", credits_left: 500 });
    api.listVideos.mockResolvedValue({
      videos: [
        { video_id: "v1", title: "My podcast", status: "done", clips_ready: 1 },
      ],
    });
    api.listClips.mockResolvedValue({ clips: [clip] });
    jest.mocked(upload).mockResolvedValue({
      ref: "video-ref" as never,
      whenUploaded: jest.fn(),
    });
  });

  it("asks a signed-out person to sign in with SnapDub", async () => {
    api.isSignedIn.mockResolvedValue(false);

    renderInTestProvider(<App />);

    expect(
      await screen.findByRole("button", { name: "Sign in with SnapDub" }),
    ).toBeTruthy();
    expect(api.listVideos).not.toHaveBeenCalled();
  });

  it("lists the videos after sign-in", async () => {
    api.isSignedIn.mockResolvedValue(false);
    api.signIn.mockResolvedValue(true);

    renderInTestProvider(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with SnapDub" }),
    );

    expect(await screen.findByText("My podcast")).toBeTruthy();
    expect(
      await screen.findByText("SnapDub Free plan, 500 credits left"),
    ).toBeTruthy();
  });

  it("puts a clicked clip on the page", async () => {
    api.isSignedIn.mockResolvedValue(true);

    renderInTestProvider(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /My podcast/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "The best moment" }),
    );

    await waitFor(() => expect(addElementAtPoint).toHaveBeenCalled());
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "video",
        mimeType: "video/mp4",
        url: clip.download_url,
        thumbnailImageUrl: clip.thumbnail_url,
        aiDisclosure: "none",
        width: 1080,
        height: 1920,
      }),
    );
    expect(addElementAtPoint).toHaveBeenCalledWith(
      expect.objectContaining({ type: "video", ref: "video-ref" }),
    );
  });

  it("shows the sign-in screen again when SnapDub says the session is over", async () => {
    api.isSignedIn.mockResolvedValue(true);
    api.whoami.mockRejectedValue(new snapdub.SignedOut());

    renderInTestProvider(<App />);

    expect(
      await screen.findByRole("button", { name: "Sign in with SnapDub" }),
    ).toBeTruthy();
  });

  it("offers a retry when SnapDub cannot be reached", async () => {
    api.isSignedIn.mockResolvedValue(true);
    api.whoami.mockRejectedValue(new Error("server_error"));

    renderInTestProvider(<App />);

    expect(
      await screen.findByRole("button", { name: "Try again" }),
    ).toBeTruthy();
  });
});
