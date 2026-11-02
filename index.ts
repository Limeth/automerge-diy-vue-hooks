import { type Ref, shallowRef, getCurrentScope, onScopeDispose } from "vue";
import * as A from "@automerge/automerge-repo";
// import * as Cabbages from "cabbages";

export const changeSubtree = Symbol("changeSubtree");
export const pathToSubtree = Symbol("pathToSubtree");

export type Incomplete<T> = {
  [P in keyof T]?: T[P];
};

/// Values which are not plain objects or arrays, and are therefore included in proxies as they are.
export type Passthrough = Date | Uint8Array | A.Counter | A.ImmutableString;

/// A type with read-only properties.
export type Ro<T> = {
  readonly [P in keyof T]: RoValue<T[P]>;
};

/// Distributes over unions, so that optional and nullable subtrees are proxies as well.
export type RoValue<V> = V extends Passthrough
  ? V
  : V extends object
    ? Rop<V>
    : V;

export type Proxy<T> = {
  [changeSubtree]: (
    changeSubtreeCallback: (subtree: T, pathToSubtree: Property[]) => void,
  ) => void;
  [pathToSubtree]: Property[];
};

/// `Rop` stands for Read-Only Proxy.
/// A proxy object representing a Vue-reactive document.
/// It contains all of the original fields, as well as a `changeSubtree` convenience method
/// (accessible via the `changeSubtree` symbol exported by this library), which acts like
/// `DocHandle<T>.change()` and operates on the subtree the method was invoked on, rather
/// than the whole document.
/// `changeSubtree` throws if the subtree has since been moved, replaced or deleted.
export type Rop<T> = Ro<T> & Proxy<T>;

export type Property = string | number;

function isProxied(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  return (
    Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype
  );
}

function pathsEqual(a: Property[], b: Property[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/// Creates a Vue-reactive proxy object of the a document, given a doc handle.
/// The `ref` is replaced on every change. Subtrees which did not change keep their proxies,
/// so that watchers and computed values depending only on them are not triggered.
/// When called within an effect scope (e.g. a component's `setup`), it stops listening for
/// changes when the scope is disposed.
export function makeReactive<T>(handle: A.DocHandle<T>): Ref<Rop<A.Doc<T>>> {
  // Automerge returns the same objects for subtrees which did not change,
  // so their proxies can be reused, as long as they are still at the same path.
  const proxies = new WeakMap<object, { path: Property[]; proxy: object }>();

  function makeProxy<U extends object>(obj: U, path: Property[]): Rop<U> {
    const cached = proxies.get(obj);
    if (cached && pathsEqual(cached.path, path)) return cached.proxy as Rop<U>;

    let proxy;

    // Include all regular properties in the proxy object, creating proxies
    // from any properties which hold a plain object or an array.
    if (Array.isArray(obj)) {
      proxy = [] as Array<Rop<U>> & Incomplete<Proxy<U>>;
      for (const [index, value] of obj.entries()) {
        if (isProxied(value))
          proxy.push(makeProxy(value, [...path, index]) as Rop<U>);
        else proxy.push(value);
      }
    } else {
      proxy = {} as Incomplete<Rop<U>>;
      for (const key of Object.getOwnPropertyNames(obj) as Array<
        keyof U & string
      >) {
        const value = obj[key];
        if (isProxied(value))
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

    const objectId = A.getObjectId(obj);

    // Add custom methods as symbol properties, so that they don't interfere with regular usage.
    (proxy[changeSubtree] as (
      changeSubtreeCallback: (subtree: U, pathToSubtree: Property[]) => void,
    ) => void) = (
      changeSubtreeCallback: (subtree: U, pathToSubtree: Property[]) => void,
    ) => {
      // `changeSubtree` operates on `A.DocHandle` directly.
      // The changes to the `A.DocHandle` are then applied to `newObj` via
      // the `on('change')` handler.
      handle.change((doc: A.Doc<T>) => {
        let subtree: any = doc;
        for (const pathSegment of path) subtree = subtree?.[pathSegment];
        // The path may lead elsewhere by now, e.g. after an earlier array element was removed.
        // Throwing rolls the change back.
        if (!isProxied(subtree) || A.getObjectId(subtree) !== objectId)
          throw new Error(
            `[automerge-diy-vue-hooks] The subtree at ${JSON.stringify(path)} was moved, replaced or deleted.`,
          );
        changeSubtreeCallback(subtree as U, path);
      });
    };

    (proxy[pathToSubtree] as Property[]) = path;

    // FIXME: Slow? https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/setPrototypeOf
    // Object.setPrototypeOf(proxy, Object.getPrototypeOf(obj));
    proxies.set(obj, { path, proxy });
    return proxy as Rop<U>;
  }

  const docProxy: Rop<A.Doc<T>> = makeProxy(handle.doc(), []);
  // The proxies are never modified, only replaced, so they need not be deeply reactive.
  const docRef = shallowRef<Rop<A.Doc<T>>>(docProxy) as Ref<Rop<A.Doc<T>>>;

  const onChange = (payload: A.DocHandleChangePayload<T>) => {
    console.debug(
      "[automerge-diy-vue-hooks] Got 'change' event, applying patches.",
      payload,
    );
    // On any change, replace the document, reusing the proxies of unchanged subtrees.
    docRef.value = makeProxy(handle.doc(), []);

    // TODO: Consider changing only updated parts of the document.
    //       Currently not reliable.
    // for (const patch of payload.patches)
    //   Cabbages.apply(docRef.value, ...Cabbages.fromAutomerge(patch, payload));
    //   // APatcher.patch(docRef.value, patch); -- fails on `A.Counter`s
  };

  handle.on("change", onChange);
  if (getCurrentScope()) onScopeDispose(() => handle.off("change", onChange));

  return docRef;
}
