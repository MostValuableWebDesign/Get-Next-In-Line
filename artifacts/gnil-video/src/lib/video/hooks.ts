import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    __replitVideoPlayerMounted?: boolean;
    __replitVideoTotalDurationMs?: number;
    startRecording?: () => Promise<void>;
    stopRecording?: () => void;
  }
}

export interface SceneDurations {
  [key: string]: number;
}

export function useVideoPlayer({
  durations,
  onVideoEnd,
  loop = true,
}: {
  durations: SceneDurations;
  onVideoEnd?: () => void;
  loop?: boolean;
}) {
  const sceneKeys = useRef(Object.keys(durations)).current;
  const durationsArray = useRef(Object.values(durations)).current;
  const [currentScene, setCurrentScene] = useState(0);
  const [hasEnded, setHasEnded] = useState(false);

  useEffect(() => {
    window.__replitVideoPlayerMounted = true;
    window.__replitVideoTotalDurationMs = durationsArray.reduce((sum: number, duration: number) => sum + duration, 0);
    window.startRecording?.();
    return () => { window.__replitVideoPlayerMounted = false; };
  }, []);

  useEffect(() => {
    if (hasEnded && !loop) return;
    const timer = window.setTimeout(() => {
      if (currentScene >= sceneKeys.length - 1) {
        if (!hasEnded) {
          window.stopRecording?.();
          setHasEnded(true);
          onVideoEnd?.();
        }
        if (loop) setCurrentScene(0);
      } else {
        setCurrentScene((scene: number) => scene + 1);
      }
    }, durationsArray[currentScene]);
    return () => window.clearTimeout(timer);
  }, [currentScene, durationsArray, hasEnded, loop, onVideoEnd, sceneKeys.length]);

  return { currentScene, totalScenes: sceneKeys.length, currentSceneKey: sceneKeys[currentScene], hasEnded };
}