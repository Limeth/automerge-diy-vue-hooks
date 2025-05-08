import { reactive } from 'vue';
import * as A from "@automerge/automerge-repo";
import * as Cabbages from "cabbages";

export const changeSubtree = Symbol('changeSubtree');

/// A proxy object representing a Vue-reactive document.
/// It contains all of the original fields, as well as a `changeSubtree` convenience method
/// (accessible via the `changeSubtree` symbol exported by this library), which acts like
/// `DocHandle<T>.change()` and operates on the subtree the method was invoked on, rather
/// than the whole document.
export type MyProxy<T> = {
  [P in keyof T]: T[P] extends object ? MyProxy<T[P]> : T[P]
} & {
  [changeSubtree]: (changeSubtreeCallback: (subtree: T) => void) => void,
};

/// Creates a Vue-reactive proxy object of the a document, given a doc handle.
export async function makeReactive<T>(handle: A.DocHandle<T>): Promise<MyProxy<A.Doc<T>> | undefined> {
  function makeProxy<U extends object>(obj: U, path: string[]): MyProxy<U> {
    const proxy = {
      // Include all regular properties in the proxy object, creating proxies
      // from any properties which hold an object.
      ...Object.fromEntries(Object.getOwnPropertyNames(obj).map((key) => {
        const value = (obj as any)[key];
        if (typeof value === 'object')
          return [key, makeProxy(value, [...path, key])];
        else
          return [key, value];
      })) as U,
      // Include all symbol properties as well, without modification.
      ...Object.fromEntries(Object.getOwnPropertySymbols(obj).map((symbol) => {
        return [symbol, (obj as any)[symbol]]
      })),
      // Add custom methods as symbol properties, so that they don't interfere with regular usage.
      [changeSubtree]: (changeSubtreeCallback: (subtree: U) => void) => {
        // `changeSubtree` operates on `A.DocHandle` directly.
        // The changes to the `A.DocHandle` are then applied to `newObj` via
        // the `on('change')` handler.
        handle.change((doc: A.Doc<T>) => {
          var subtree: any = doc;
          for (const pathSegment of path)
            subtree = subtree[pathSegment];
          changeSubtreeCallback(subtree);
        })
      },
    } as MyProxy<U>;
    // FIXME: Slow? https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/setPrototypeOf
    // Object.setPrototypeOf(proxy, Object.getPrototypeOf(obj));
    return proxy;
  }

  const doc: A.Doc<T> | undefined = await handle.doc();

  // TODO: There's a PR for this in AM
  if (doc === undefined) {
    return undefined;
  }

  const docProxy: MyProxy<A.Doc<T>> = makeProxy(doc, []);
  const docRef: MyProxy<A.Doc<T>> = reactive(docProxy) as any as MyProxy<A.Doc<T>>;

  handle.on('change', (payload) => {
    console.trace("[automerge-diy-vue-hooks] Got 'change' event, applying patches.", payload);
    for (const patch of payload.patches)
      Cabbages.apply(docRef, ...Cabbages.fromAutomerge(patch, payload));
      // APatcher.patch(docRef, patch); -- fails on `A.Counter`s
  });

  return docRef;
}
