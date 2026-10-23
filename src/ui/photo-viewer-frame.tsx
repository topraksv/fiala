/** Both viewers' window, in a file of its own: inside `photo-viewer.native.tsx`, `./photo-viewer` resolves to that file itself. */
import type { ReactNode } from "react";
import { Modal, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import X from "lucide-react-native/icons/x";

import { tr } from "../i18n/tr";
import { useReducedMotion } from "./motion";
import { Press } from "./press";
import { circle, controlSize, iconSize, iconStroke, photoViewer, spacing } from "./theme";

export interface PhotoViewerProps {
  uri: string;
  /** What the photo is, said by a screen reader. */
  label: string;
  onClose: () => void;
}

/**
 * The black window and its close button. A Modal, so Escape and the phone's
 * back both reach `onClose`, and no opening animation under reduced motion.
 */
export function PhotoViewerFrame({ label, onClose, children }: Omit<PhotoViewerProps, "uri"> & { children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  return (
    <Modal aria-label={label} animationType={reducedMotion ? "none" : "fade"} visible onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: photoViewer.backdrop }}>
        {children}
        <View style={{ position: "absolute", top: insets.top + spacing.sm, right: Math.max(insets.right, spacing.sm) }}>
          <Press
            accessibilityRole="button"
            accessibilityLabel={tr.common.close}
            onPress={onClose}
            style={{
              width: controlSize.minimumTarget,
              height: controlSize.minimumTarget,
              borderRadius: circle(controlSize.minimumTarget),
              backgroundColor: photoViewer.chip,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X accessible={false} size={iconSize.headerBack} color={photoViewer.ink} strokeWidth={iconStroke.regular} />
          </Press>
        </View>
      </View>
    </Modal>
  );
}
