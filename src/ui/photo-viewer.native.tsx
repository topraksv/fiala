/**
 * The photo full screen with the gestures a photo is looked at with: pinch
 * from the whole photo to `maxZoom`, drag while zoomed, double tap between
 * the whole and `doubleTapZoom`. Reanimated shared values keep the gesture on
 * the UI thread; the `.native` split keeps both libraries out of the web
 * bundle (`photo-viewer.tsx`).
 */
import { useState } from "react";
import { useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

import { PhotoViewerFrame, type PhotoViewerProps } from "./photo-viewer-frame";
import { motion, photoViewer } from "./theme";
import { clampPan, clampScale } from "./zoom";

const SPRING = { ...motion.spring.entrance, reduceMotion: ReduceMotion.System };

export function PhotoViewer({ uri, label, onClose }: PhotoViewerProps) {
  const { width, height } = useWindowDimensions();
  // The photo's width over its height, once loaded; the window's until then.
  const [ratio, setRatio] = useState(width / height);
  // Where `contain` draws it at 1x.
  const shownWidth = Math.min(width, height * ratio);
  const shownHeight = Math.min(height, width / ratio);
  const scale = useSharedValue<number>(photoViewer.minZoom);
  const held = useSharedValue<number>(photoViewer.minZoom);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const heldX = useSharedValue(0);
  const heldY = useSharedValue(0);

  // Springs home inside the bounds the scale now allows; ReduceMotion.System
  // makes the setting jump instead (`list-motion.native.tsx`).
  const settle = () => {
    "worklet";
    heldX.value = clampPan(x.value, shownWidth, width, scale.value);
    heldY.value = clampPan(y.value, shownHeight, height, scale.value);
    x.value = withSpring(heldX.value, SPRING);
    y.value = withSpring(heldY.value, SPRING);
  };

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = clampScale(held.value * event.scale, photoViewer.minZoom, photoViewer.maxZoom);
    })
    .onEnd(() => {
      held.value = scale.value;
      settle();
    });

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      x.value = clampPan(heldX.value + event.translationX, shownWidth, width, scale.value);
      y.value = clampPan(heldY.value + event.translationY, shownHeight, height, scale.value);
    })
    .onEnd(() => {
      heldX.value = x.value;
      heldY.value = y.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const to = scale.value > photoViewer.minZoom ? photoViewer.minZoom : photoViewer.doubleTapZoom;
      scale.value = withSpring(to, SPRING);
      held.value = to;
      x.value = withSpring(0, SPRING);
      y.value = withSpring(0, SPRING);
      heldX.value = 0;
      heldY.value = 0;
    });

  const gesture = Gesture.Exclusive(doubleTap, Gesture.Simultaneous(pinch, pan));
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  return (
    <PhotoViewerFrame label={label} onClose={onClose}>
      {/* A Modal is a window of its own on Android, outside the app's gesture root. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <GestureDetector gesture={gesture}>
          <Animated.Image
            source={{ uri }}
            accessibilityLabel={label}
            resizeMode="contain"
            onLoad={({ nativeEvent: { source } }) => source.width > 0 && source.height > 0 && setRatio(source.width / source.height)}
            style={[{ width, height }, style]}
          />
        </GestureDetector>
      </GestureHandlerRootView>
    </PhotoViewerFrame>
  );
}
