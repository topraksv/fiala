/**
 * The cabinet's list of what to buy (`docs/TASKS.md` F1.23): the products
 * marked on their page, and those whose every box at home is running low,
 * offered to be marked. It leaves the app as text, never to Gital: the
 * family excluded that bridge.
 */

import { View } from "react-native";
import Check from "lucide-react-native/icons/check";
import Plus from "lucide-react-native/icons/plus";
import Share from "lucide-react-native/icons/share";
import ShoppingBasket from "lucide-react-native/icons/shopping-basket";

import { editProduct, type CabinetProduct } from "../data/cabinet";
import { useCabinet } from "../data/hooks";
import { isEmpty, isLow } from "../domain/boxes";
import { tr } from "../i18n/tr";
import { shareText } from "../services/share";
import { Card, EmptyState, IconButton, ListRow, ReadFailed, Screen, SectionHeader } from "../ui/components";
import { appError } from "../ui/dialog";
import { showNotice, showUndo } from "../ui/undo";

const titleOf = (product: CabinetProduct) => tr.common.joined(product.name, product.strength ?? undefined);

export default function ToBuy() {
  const cabinet = useCabinet();
  const wanted = cabinet.data.filter((product) => product.wanted);
  const running = cabinet.data.filter((product) => {
    const home = product.boxes.filter((box) => box.disposition == null);
    return !product.wanted && home.length > 0 && home.every((box) => isEmpty(box) || isLow(box));
  });

  const mark = async (product: CabinetProduct, on: boolean) => {
    try {
      await editProduct(product.id, { wanted: on });
      if (!on) showUndo(tr.toBuy.boughtNotice(titleOf(product)), () => editProduct(product.id, { wanted: true }));
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };
  const share = async () => {
    try {
      const text = [tr.toBuy.title, ...wanted.map((product) => `• ${titleOf(product)}`)].join("\n");
      if ((await shareText(text)) === "clipboard") showNotice(tr.toBuy.copied);
    } catch {
      await appError(tr.errors.shareFailed);
    }
  };

  if (cabinet.status === "error") {
    return (
      <Screen back="/" title={tr.toBuy.title}>
        <ReadFailed queries={[cabinet]} />
      </Screen>
    );
  }
  return (
    <Screen
      back="/"
      title={tr.toBuy.title}
      actions={wanted.length > 0 ? <IconButton icon={Share} label={tr.toBuy.share} onPress={() => void share()} /> : null}
    >
      {cabinet.status === "loading" ? null : wanted.length === 0 ? (
        <EmptyState icon={ShoppingBasket} title={tr.toBuy.emptyTitle} hint={tr.toBuy.emptyHint} />
      ) : (
        <Card rows>
          {wanted.map((product) => (
            <ListRow
              key={product.id}
              title={titleOf(product)}
              right={<IconButton icon={Check} label={tr.toBuy.bought(titleOf(product))} tone="primary" onPress={() => void mark(product, false)} />}
            />
          ))}
        </Card>
      )}
      {running.length > 0 ? (
        <View>
          <SectionHeader>{tr.toBuy.suggestions}</SectionHeader>
          <Card rows>
            {running.map((product) => (
              <ListRow
                key={product.id}
                title={titleOf(product)}
                right={<IconButton icon={Plus} label={tr.toBuy.add(titleOf(product))} onPress={() => void mark(product, true)} />}
              />
            ))}
          </Card>
        </View>
      ) : null}
    </Screen>
  );
}
