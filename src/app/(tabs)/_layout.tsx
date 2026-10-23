import { Tabs } from "expo-router/js-tabs";
import BookOpen from "lucide-react-native/icons/book-open";
import BriefcaseMedical from "lucide-react-native/icons/briefcase-medical";
import House from "lucide-react-native/icons/house";
import Settings from "lucide-react-native/icons/settings";
import type { LucideIcon } from "lucide-react-native";

import { tr } from "../../i18n/tr";
import { selectionTapIfChanged } from "../../ui/haptics";
import { TabBar } from "../../ui/tab-bar";
import { useTheme } from "../../ui/theme";

const TABS: readonly { name: string; title: string; Icon: LucideIcon }[] = [
  { name: "index", title: tr.tabs.status, Icon: House },
  { name: "cabinet", title: tr.tabs.cabinet, Icon: BriefcaseMedical },
  { name: "guide", title: tr.tabs.guide, Icon: BookOpen },
  { name: "settings", title: tr.tabs.settings, Icon: Settings },
];

export default function TabsLayout() {
  const { palette } = useTheme();
  return (
    <Tabs
      // The bar floats over the scene and draws itself; `Screen` reads the same
      // TAB_BAR tokens to clear it.
      tabBar={(props) => <TabBar {...props} />}
      screenListeners={({ navigation, route }) => ({
        tabPress: () => {
          const state = navigation.getState();
          selectionTapIfChanged(state.routes[state.index]?.key, route.key);
        },
      })}
      // No `animation`: a page does not move on a visit (`docs/UI.md` section 7).
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: palette.background },
      }}
    >
      {TABS.map(({ name, title, Icon }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title,
            tabBarAccessibilityLabel: title,
            tabBarIcon: ({ color, size }) => <Icon color={color} size={size} />,
          }}
        />
      ))}
    </Tabs>
  );
}
