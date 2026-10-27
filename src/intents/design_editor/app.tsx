// The SnapDub panel inside Canva: sign in with SnapDub, pick one of your videos, then click or drag
// a finished clip onto the page. Clips are made in SnapDub (captions, reframing and titles already
// done); this panel only brings them into the design.
import { useFeatureSupport } from "@canva/app-hooks";
import {
  Alert,
  Box,
  Button,
  Column,
  Columns,
  Grid,
  HorizontalCard,
  LoadingIndicator,
  Rows,
  Text,
  Title,
  VideoCard,
} from "@canva/app-ui-kit";
import { upload } from "@canva/asset";
import { addElementAtCursor, addElementAtPoint, ui } from "@canva/design";
import { getPlatformInfo, requestOpenExternalUrl } from "@canva/platform";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import * as styles from "styles/components.css";
import type { Account, Clip, Video } from "../../snapdub";
import {
  isSignedIn,
  listClips,
  listVideos,
  signIn,
  SignedOut,
  signOut,
  SNAPDUB_URL,
  whoami,
} from "../../snapdub";

// Download links last an hour; fetch fresh ones before they can die mid-upload.
const LINKS_FRESH_FOR_MS = 45 * 60 * 1000;

type Screen =
  | { name: "loading" }
  | { name: "signed_out" }
  | { name: "error"; retry: () => void }
  | { name: "videos" }
  | { name: "clips"; video: Video };

type Notice = { tone: "positive" | "critical"; text: string };

export const App = () => {
  const intl = useIntl();
  const isSupported = useFeatureSupport();
  const addElement = [addElementAtPoint, addElementAtCursor].find((fn) =>
    isSupported(fn),
  );

  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [account, setAccount] = useState<Account | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [nextPage, setNextPage] = useState<number | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [clipsAt, setClipsAt] = useState(0);
  const [busyClip, setBusyClip] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [canPay, setCanPay] = useState(false);

  const handleError = useCallback((error: unknown, retry: () => void) => {
    if (error instanceof SignedOut) setScreen({ name: "signed_out" });
    else setScreen({ name: "error", retry });
  }, []);

  const loadVideos = useCallback(async () => {
    setScreen({ name: "loading" });
    try {
      const [me, page] = await Promise.all([whoami(), listVideos(1)]);
      setAccount(me);
      setVideos(page.videos || []);
      setNextPage(page.next_page);
      setMoreFailed(false);
      setScreen({ name: "videos" });
    } catch (error) {
      handleError(error, loadVideos);
    }
  }, [handleError]);

  const start = useCallback(async () => {
    try {
      if (await isSignedIn()) await loadVideos();
      else setScreen({ name: "signed_out" });
    } catch (error) {
      handleError(error, start);
    }
  }, [loadVideos, handleError]);

  useEffect(() => {
    start();
    setCanPay(getPlatformInfo().canAcceptPayments);
  }, [start]);

  const onSignIn = async () => {
    try {
      if (await signIn()) await loadVideos();
    } catch (error) {
      handleError(error, onSignIn);
    }
  };

  const onSignOut = async () => {
    await signOut().catch(() => undefined);
    setAccount(null);
    setVideos([]);
    setScreen({ name: "signed_out" });
  };

  // The next 20 older videos, appended under the ones already shown.
  const loadMore = useCallback(async () => {
    if (!nextPage || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listVideos(nextPage);
      setVideos((shown) => [...shown, ...(page.videos || [])]);
      setNextPage(page.next_page);
      setMoreFailed(false);
    } catch (error) {
      if (error instanceof SignedOut) setScreen({ name: "signed_out" });
      else setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [nextPage, loadingMore]);

  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !nextPage || moreFailed) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [nextPage, moreFailed, loadMore, screen]);

  const openVideo = useCallback(
    async (video: Video) => {
      setScreen({ name: "clips", video });
      setClips(null);
      setNotice(null);
      try {
        const result = await listClips(video.video_id);
        setClips(result.clips || []);
        setClipsAt(Date.now());
      } catch (error) {
        handleError(error, () => openVideo(video));
      }
    },
    [handleError],
  );

  // The clip with a download link that will still be alive while Canva fetches it.
  const freshClip = async (video: Video, clip: Clip): Promise<Clip> => {
    if (Date.now() - clipsAt < LINKS_FRESH_FOR_MS) return clip;
    const result = await listClips(video.video_id);
    setClips(result.clips || []);
    setClipsAt(Date.now());
    return (result.clips || []).find((c) => c.clip_id === clip.clip_id) || clip;
  };

  const uploadClip = async (clip: Clip) => {
    if (!clip.download_url || !clip.thumbnail_url) throw new Error("no_file");
    const size =
      clip.width && clip.height
        ? { width: clip.width, height: clip.height }
        : {};
    return upload({
      type: "video",
      mimeType: "video/mp4",
      url: clip.download_url,
      thumbnailImageUrl: clip.thumbnail_url,
      name: clip.title,
      // Cut and framed from the person's own video; nothing in the picture is generated.
      aiDisclosure: "none",
      ...size,
    });
  };

  const addClip = async (video: Video, clip: Clip) => {
    if (!addElement || busyClip) return;
    setBusyClip(clip.clip_id);
    setNotice(null);
    try {
      const queued = await uploadClip(await freshClip(video, clip));
      await addElement({
        type: "video",
        ref: queued.ref,
        altText: {
          text: clip.title || video.title || "Clip",
          decorative: false,
        },
      });
      setNotice({
        tone: "positive",
        text: intl.formatMessage({
          defaultMessage:
            "Clip added. It may take a moment to finish uploading.",
          description: "Shown after a clip was placed on the page.",
        }),
      });
    } catch (error) {
      if (error instanceof SignedOut) {
        setScreen({ name: "signed_out" });
        return;
      }
      setNotice({
        tone: "critical",
        text: intl.formatMessage({
          defaultMessage: "That clip didn't come through. Please try again.",
          description: "Shown when adding a clip to the page failed.",
        }),
      });
    } finally {
      setBusyClip(null);
    }
  };

  const dragClip = (
    event: React.DragEvent<HTMLElement>,
    video: Video,
    clip: Clip,
  ) => {
    if (!clip.thumbnail_url) return;
    const width = clip.width || 1080;
    const height = clip.height || 1920;
    ui.startDragToPoint(event, {
      type: "video",
      resolveVideoRef: async () => uploadClip(await freshClip(video, clip)),
      previewUrl: clip.thumbnail_url,
      previewSize: { width: 90, height: Math.round((90 * height) / width) },
      fullSize: { width, height },
    });
  };

  const openSnapDub = (path: string) =>
    requestOpenExternalUrl({ url: `${SNAPDUB_URL}${path}` });

  if (screen.name === "loading") {
    return (
      <div className={styles.scrollContainer}>
        <Box paddingTop="8u" display="flex" justifyContent="center">
          <LoadingIndicator size="medium" />
        </Box>
      </div>
    );
  }

  if (screen.name === "signed_out") {
    return (
      <div className={styles.scrollContainer}>
        <Rows spacing="2u">
          <Title size="small">
            {intl.formatMessage({
              defaultMessage: "Your SnapDub clips, right in your design",
              description: "Heading on the sign-in screen.",
            })}
          </Title>
          <Text>
            {intl.formatMessage({
              defaultMessage:
                "SnapDub turns your long videos into short vertical clips with captions. Sign in to add your clips to this design with one click or by dragging them onto the page.",
              description: "What the app does, on the sign-in screen.",
            })}
          </Text>
          <Button variant="primary" stretch onClick={onSignIn}>
            {intl.formatMessage({
              defaultMessage: "Sign in with SnapDub",
              description: "Button that opens the SnapDub sign-in window.",
            })}
          </Button>
          <Text size="small" tone="tertiary">
            {intl.formatMessage({
              defaultMessage:
                "New to SnapDub? You can create a free account in the same window.",
              description: "Hint under the sign-in button.",
            })}
          </Text>
        </Rows>
      </div>
    );
  }

  if (screen.name === "error") {
    return (
      <div className={styles.scrollContainer}>
        <Rows spacing="2u">
          <Alert tone="critical">
            {intl.formatMessage({
              defaultMessage:
                "SnapDub didn't answer. Check your connection and try again.",
              description: "Shown when SnapDub could not be reached.",
            })}
          </Alert>
          <Button variant="secondary" stretch onClick={screen.retry}>
            {intl.formatMessage({
              defaultMessage: "Try again",
              description: "Retry button.",
            })}
          </Button>
        </Rows>
      </div>
    );
  }

  const upgradeUrl = account?.upgrade_url;
  const footer = (
    <Box paddingTop="2u">
      <Rows spacing="1u">
        {account && (
          <Text size="small" tone="tertiary">
            {intl.formatMessage(
              {
                defaultMessage: "SnapDub {plan} plan, {credits} credits left",
                description:
                  "The person's SnapDub plan and credits. Keep the word SnapDub.",
              },
              {
                plan: account.plan || "Free",
                credits: account.credits_left ?? 0,
              },
            )}
          </Text>
        )}
        <Columns spacing="1u">
          {canPay && upgradeUrl && (
            <Column width="content">
              <Button
                variant="tertiary"
                onClick={() => requestOpenExternalUrl({ url: upgradeUrl })}
              >
                {intl.formatMessage({
                  defaultMessage: "Manage plan",
                  description: "Opens SnapDub billing.",
                })}
              </Button>
            </Column>
          )}
          <Column width="content">
            <Button variant="tertiary" onClick={onSignOut}>
              {intl.formatMessage({
                defaultMessage: "Sign out",
                description: "Signs out of SnapDub.",
              })}
            </Button>
          </Column>
        </Columns>
      </Rows>
    </Box>
  );

  if (screen.name === "clips") {
    const video = screen.video;
    return (
      <div className={styles.scrollContainer}>
        <Rows spacing="2u">
          <Box>
            <Button
              variant="tertiary"
              onClick={() => setScreen({ name: "videos" })}
            >
              {intl.formatMessage({
                defaultMessage: "Back to your videos",
                description: "Back to the video list.",
              })}
            </Button>
          </Box>
          <Title size="xsmall">{video.title || ""}</Title>
          {notice && (
            <Alert tone={notice.tone} onDismiss={() => setNotice(null)}>
              {notice.text}
            </Alert>
          )}
          {clips == null ? (
            <Box paddingTop="4u" display="flex" justifyContent="center">
              <LoadingIndicator />
            </Box>
          ) : clips.length === 0 ? (
            <Text>
              {intl.formatMessage({
                defaultMessage: "This video has no clips yet.",
                description: "Empty clips list.",
              })}
            </Text>
          ) : (
            <>
              <Text size="small" tone="tertiary">
                {intl.formatMessage({
                  defaultMessage:
                    "Best clips first. Click one to add it, or drag it onto the page.",
                  description: "Hint above the clips grid.",
                })}
              </Text>
              <Grid columns={2} spacing="1u">
                {clips.map((clip) => (
                  <VideoCard
                    key={clip.clip_id}
                    ariaLabel={clip.title || ""}
                    thumbnailUrl={clip.thumbnail_url || ""}
                    videoPreviewUrl={clip.download_url || ""}
                    mimeType="video/mp4"
                    durationInSeconds={clip.duration_seconds}
                    thumbnailAspectRatio={
                      (clip.width || 9) / (clip.height || 16)
                    }
                    loading={busyClip === clip.clip_id}
                    disabled={!addElement || !clip.download_url}
                    onClick={() => addClip(video, clip)}
                    onDragStart={(event: React.DragEvent<HTMLElement>) =>
                      dragClip(event, video, clip)
                    }
                  />
                ))}
              </Grid>
            </>
          )}
          {footer}
        </Rows>
      </div>
    );
  }

  const describe = (video: Video) => {
    const ready = video.clips_ready || 0;
    if (ready) {
      return intl.formatMessage(
        {
          defaultMessage: "{count, plural, one {# clip} other {# clips}}",
          description: "How many clips a video has.",
        },
        { count: ready },
      );
    }
    if (video.status === "failed") {
      return intl.formatMessage({
        defaultMessage: "Failed",
        description: "Video status.",
      });
    }
    if (video.status === "done") {
      return intl.formatMessage({
        defaultMessage: "No clips",
        description: "Video status.",
      });
    }
    return intl.formatMessage({
      defaultMessage: "Still being made",
      description: "Video status while SnapDub works on it.",
    });
  };

  return (
    <div className={styles.scrollContainer}>
      <Rows spacing="2u">
        <Title size="xsmall">
          {intl.formatMessage({
            defaultMessage: "Your videos",
            description: "Heading of the video list.",
          })}
        </Title>
        {videos.length === 0 ? (
          <Rows spacing="1u">
            <Text>
              {intl.formatMessage({
                defaultMessage:
                  "No videos yet. Paste a link or upload a video in SnapDub, and its clips show up here.",
                description: "Empty video list.",
              })}
            </Text>
            <Button
              variant="secondary"
              stretch
              onClick={() => openSnapDub("/videos/new")}
            >
              {intl.formatMessage({
                defaultMessage: "Make clips in SnapDub",
                description: "Opens SnapDub to start a video.",
              })}
            </Button>
          </Rows>
        ) : (
          <Rows spacing="1u">
            {videos.map((video) => (
              <HorizontalCard
                key={video.video_id}
                title={video.title || ""}
                description={describe(video)}
                disabled={!video.clips_ready}
                onClick={() => openVideo(video)}
              />
            ))}
            <div ref={sentinel} />
            {loadingMore && (
              <Box display="flex" justifyContent="center">
                <LoadingIndicator />
              </Box>
            )}
            {moreFailed && (
              <Button variant="tertiary" stretch onClick={loadMore}>
                {intl.formatMessage({
                  defaultMessage: "Load older videos",
                  description: "Retry loading more videos.",
                })}
              </Button>
            )}
          </Rows>
        )}
        <Box>
          <Button variant="tertiary" onClick={loadVideos}>
            {intl.formatMessage({
              defaultMessage: "Refresh",
              description: "Reloads the video list.",
            })}
          </Button>
        </Box>
        {footer}
      </Rows>
    </div>
  );
};
