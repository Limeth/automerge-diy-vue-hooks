import { type Ref, ref } from "vue";
import * as A from "@automerge/automerge-repo";
// import * as Cabbages from "cabbages";

export const changeSubtree = Symbol("changeSubtree");

export type Incomplete<T> = {
  [P in keyof T]?: T[P];
};

/// A type with read-only properties.
export type Ro<T> = {
  readonly [P in keyof T]: T[P] extends object ? Rop<T[P]> : T[P];
};

export type Proxy<T> = {
  [changeSubtree]: (changeSubtreeCallback: (subtree: T) => void) => void;
};

/// `Rop` stands for Read-Only Proxy.
/// A proxy object representing a Vue-reactive document.
/// It contains all of the original fields, as well as a `changeSubtree` convenience method
/// (accessible via the `changeSubtree` symbol exported by this library), which acts like
/// `DocHandle<T>.change()` and operates on the subtree the method was invoked on, rather
/// than the whole document.
export type Rop<T> = Ro<T> & Proxy<T>;

/// Creates a Vue-reactive proxy object of the a document, given a doc handle.
export function makeReactive<T>(handle: A.DocHandle<T>): Ref<Rop<A.Doc<T>>> {
  function makeProxy<U extends object>(
    obj: U,
    path: (string | number)[],
  ): Rop<U> {
    let proxy;

    // Include all regular properties in the proxy object, creating proxies
    // from any properties which hold an object.
    if (Array.isArray(obj)) {
      proxy = [] as Array<Rop<U>> & Incomplete<Proxy<T>>;
      for (const [index, value] of obj.entries()) {
        if (value !== null && typeof value === "object")
          proxy.push(makeProxy(value, [...path, index]));
        else proxy.push(value);
      }
    } else {
      proxy = {} as Incomplete<Rop<U>>;
      for (const key of Object.getOwnPropertyNames(obj) as Array<
        keyof U & string
      >) {
        const value = obj[key];
        if (value !== null && typeof value === "object")
          (proxy[key] as Rop<U[keyof U & string] & object>) = makeProxy(value, [
            ...path,
            key,
          ]);
        else (proxy[key] as U[keyof U & string]) = value;
      }
    }

    // Include all symbol properties as well, without modification.
    for (const symbol of Object.getOwnPropertySymbols(obj) as Array<
      keyof U & symbol
    >)
      (proxy[symbol as keyof typeof proxy] as unknown) = obj[symbol];

    // Add custom methods as symbol properties, so that they don't interfere with regular usage.
    (proxy[changeSubtree] as (
      changeSubtreeCallback: (subtree: U) => void,
    ) => void) = (changeSubtreeCallback: (subtree: U) => void) => {
      // `changeSubtree` operates on `A.DocHandle` directly.
      // The changes to the `A.DocHandle` are then applied to `newObj` via
      // the `on('change')` handler.
      handle.change((doc: A.Doc<T>) => {
        let subtree: any = doc;
        for (const pathSegment of path) subtree = subtree[pathSegment];
        changeSubtreeCallback(subtree as U);
      });
    };

    // FIXME: Slow? https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/setPrototypeOf
    // Object.setPrototypeOf(proxy, Object.getPrototypeOf(obj));
    return proxy as Rop<U>;
  }

  const docProxy: Rop<A.Doc<T>> = makeProxy(handle.doc(), []);
  const docRef = ref<Rop<A.Doc<T>>>(docProxy) as Ref<Rop<A.Doc<T>>>;

  handle.on("change", (payload) => {
    console.debug(
      "[automerge-diy-vue-hooks] Got 'change' event, applying patches.",
      payload,
    );
    // On any change, replace the whole document.
    docRef.value = makeProxy(handle.doc(), []);

    // TODO: Consider changing only updated parts of the document.
    //       Currently not reliable.
    // for (const patch of payload.patches)
    //   Cabbages.apply(docRef.value, ...Cabbages.fromAutomerge(patch, payload));
    //   // APatcher.patch(docRef.value, patch); -- fails on `A.Counter`s
  });

  return docRef;
}
