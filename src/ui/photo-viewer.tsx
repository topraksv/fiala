/**
 * A photo opened full screen (`docs/UI.md` section 6). On the web it is shown
 * whole and not zoomed: the browser zooms a page itself, and a gesture library
 * would cost every visitor its download — the boundary `list-motion.tsx` draws.
 * The native file wraps the same frame around a pinchable image.
 */
import { Image, StyleSheet } from "react-native";

import { PhotoViewerFrame, type PhotoViewerProps } from "./photo-viewer-frame";

export function PhotoViewer({ uri, label, onClose }: PhotoViewerProps) {
  return (
    <PhotoViewerFrame label={label} onClose={onClose}>
      <Image source={{ uri }} accessibilityLabel={label} resizeMode="contain" style={StyleSheet.absoluteFill} />
    </PhotoViewerFrame>
  );
}
