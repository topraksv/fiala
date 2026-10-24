/** Native half of the pharmacy map; web deliberately resolves pharmacy-map.tsx. */

import { useState } from "react";
import { View } from "react-native";
import MapView, { Marker, type Region } from "react-native-maps";
import Search from "lucide-react-native/icons/search";

import { tr } from "../i18n/tr";
import { boxOfRegion } from "../services/guide";
import { Button } from "./components";
import { pharmacyName } from "./guide";
import type { PharmacyMapProps } from "./pharmacy-map";
import { borderWidth, radius, spacing, useTheme } from "./theme";

export const HAS_MAP = true;

/** About ten kilometres across at Türkiye's latitudes: a district, not the province. */
const OPENING_SPAN = 0.09;
const MAP_HEIGHT = 420;

/**
 * The platform's map (Apple's on iOS, Google's on Android, as Expo Go ships
 * them) with no "you are here": the map would hold the precise position the
 * screen keeps off the server. The search asks for what the map shows only
 * when it is told to, so panning sends nothing.
 */
export function PharmacyMap({ pharmacies, middle, onOpen, onSearch }: PharmacyMapProps) {
  const { palette } = useTheme();
  const [region, setRegion] = useState<Region | null>(null);
  return (
    <View style={{ height: MAP_HEIGHT, borderRadius: radius.lg, overflow: "hidden", borderWidth: borderWidth.outline, borderColor: palette.border, marginBottom: spacing.md }}>
      <MapView
        style={{ flex: 1 }}
        initialRegion={{ latitude: middle.lat, longitude: middle.lon, latitudeDelta: OPENING_SPAN, longitudeDelta: OPENING_SPAN }}
        onRegionChangeComplete={setRegion}
        toolbarEnabled={false}
      >
        {pharmacies.map((pharmacy) => (
          <Marker
            key={pharmacy.id}
            coordinate={{ latitude: pharmacy.lat, longitude: pharmacy.lon }}
            title={pharmacyName(pharmacy)}
            description={pharmacy.neighbourhood ?? pharmacy.district ?? undefined}
            pinColor={palette.primary}
            onCalloutPress={() => onOpen(pharmacy)}
          />
        ))}
      </MapView>
      {region ? (
        <View style={{ position: "absolute", top: spacing.sm, alignSelf: "center" }}>
          <Button
            label={tr.pharmacies.searchHere}
            icon={Search}
            size="sm"
            onPress={() => onSearch(boxOfRegion({ lat: region.latitude, lon: region.longitude }, region.latitudeDelta, region.longitudeDelta))}
          />
        </View>
      ) : null}
    </View>
  );
}
