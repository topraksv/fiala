/**
 * The photo of a person, a product or a box (`docs/TASKS.md` F1.19, F1.20),
 * the one place any of them is taken: shown when there is one, taken from
 * the camera or picked from the library, and taken off. Gital's, saved as it
 * is chosen, as every field on these pages is.
 */

import { useEffect, useState } from "react";
import { Image, Platform, Text, View } from "react-native";
import Camera from "lucide-react-native/icons/camera";
import ImagePlus from "lucide-react-native/icons/image-plus";
import X from "lucide-react-native/icons/x";
import type { LucideIcon } from "lucide-react-native";

import { readPhoto, type NewPhoto } from "../data/photos";
import { tr } from "../i18n/tr";
import { Body, IconButton } from "./components";
import { appError } from "./dialog";
import { interactionSurface } from "./interaction";
import { PhotoViewer } from "./photo-viewer";
import { Press } from "./press";
import { borderWidth, circle, font, iconStroke, photoPreview, radius, spacing, type, useTheme } from "./theme";

const loadTake = () => import("./photo-take").then((module) => module.default);

/** The stored photo at full size once read, its thumbnail until then. */
function useStored(photoId: string | null | undefined, thumb: string | null | undefined): string | null {
  const [full, setFull] = useState<{ id: string; data: string } | null>(null);
  useEffect(() => {
    if (!photoId) return;
    let live = true;
    readPhoto(photoId).then(
      (data) => live && data && setFull({ id: photoId, data }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [photoId]);
  return full && full.id === photoId ? full.data : (thumb ?? null);
}

export function PhotoField({
  name,
  photoId,
  thumb,
  onChange,
}: {
  name: string;
  photoId: string | null;
  thumb: string | null;
  /** Absent where the person only reads: the photo is shown, never changed. */
  onChange?: (change: NewPhoto | null) => void;
}) {
  const { palette } = useTheme();
  const shown = useStored(photoId, thumb);
  const [enlarged, setEnlarged] = useState(false);
  // Fetched while the page is open, so the first tap offline still finds the chunk.
  useEffect(() => void loadTake().catch(() => {}), []);
  const take = (from: "camera" | "library") =>
    loadTake()
      .then((takePhoto) => takePhoto(from))
      .then(
        (taken) => {
          if (taken === "denied") return appError(tr.photos.denied);
          if (taken !== "cancelled") onChange?.(taken);
        },
        () => appError(tr.photos.failed),
      );
  // A phone's browser offers its camera from the file picker itself, so the
  // web has one way in where a phone app has two.
  const sources: [LucideIcon, string, "camera" | "library"][] =
    Platform.OS === "web"
      ? [[ImagePlus, shown ? tr.photos.change : tr.photos.add, "library"]]
      : [[Camera, tr.photos.camera, "camera"], [ImagePlus, tr.photos.library, "library"]];
  if (!onChange && !shown) return null;
  return (
    <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
      <Body>{tr.photos.title}</Body>
      {shown ? (
        <View>
          <Press accessibilityRole="button" accessibilityLabel={tr.common.withDetail(tr.photos.enlarge, tr.photos.of(name))} onPress={() => setEnlarged(true)}>
            <Image
              source={{ uri: shown }}
              accessible={false}
              resizeMode="contain"
              style={{ width: "100%", height: photoPreview.height, borderRadius: radius.md, backgroundColor: palette.surfaceAlt }}
            />
          </Press>
          {enlarged ? <PhotoViewer uri={shown} label={tr.photos.of(name)} onClose={() => setEnlarged(false)} /> : null}
          {/* On the photo's own corners: what is drawn is what they act on. */}
          {onChange ? (
            <>
              <View style={{ position: "absolute", top: spacing.xs, right: spacing.xs }}>
                <IconButton icon={X} label={tr.photos.remove} onPress={() => onChange(null)} />
              </View>
              <View style={{ position: "absolute", bottom: spacing.xs, right: spacing.xs, flexDirection: "row" }}>
                {sources.map(([icon, label, from]) => (
                  <IconButton key={from} icon={icon} label={label} onPress={() => void take(from)} />
                ))}
              </View>
            </>
          ) : null}
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          {sources.map(([icon, label, from]) => (
            <Source key={from} icon={icon} label={label} onPress={() => void take(from)} />
          ))}
        </View>
      )}
    </View>
  );
}

/** One way to bring a photo in, drawn as the empty frame it would fill; a document's file too. */
export function Source({ icon: Icon, label, onPress }: { icon: LucideIcon; label: string; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={(state) => ({
        flex: 1,
        minHeight: photoPreview.source,
        padding: spacing.sm,
        gap: spacing.sm,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.md,
        borderWidth: borderWidth.control,
        borderStyle: "dashed",
        borderColor: palette.controlBorder,
        ...interactionSurface(palette, state, { base: palette.surfaceAlt }),
      })}
    >
      <View
        style={{
          width: photoPreview.disc,
          height: photoPreview.disc,
          borderRadius: circle(photoPreview.disc),
          backgroundColor: palette.primarySoft,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon accessible={false} size={photoPreview.icon} color={palette.accentText} strokeWidth={iconStroke.quiet} />
      </View>
      <Text style={[type.small, { color: palette.text, fontFamily: font.medium, textAlign: "center" }]}>{label}</Text>
    </Press>
  );
}
