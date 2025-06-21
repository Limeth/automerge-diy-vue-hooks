import { reactive, Reactive, Ref, ref, UnwrapRef } from 'vue';
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
export function makeReactive<T>(handle: A.DocHandle<T>): Ref<MyProxy<A.Doc<T>>> {
  function makeProxy<U extends object>(obj: U, path: (string | number)[]): MyProxy<U> {
    var proxy: Array<any> | Object | undefined;
    
    // Include all regular properties in the proxy object, creating proxies
    // from any properties which hold an object.
    if (Array.isArray(obj))
    {
      proxy = new Array();
      for (const [index, value] of obj.entries())
      {
        if (typeof value === 'object')
          (proxy as Array<any>).push(makeProxy(value, [...path, index]))
        else
          (proxy as Array<any>).push(value);
      }
    }
    else
    {
      proxy = new Object();
      for (const key of Object.getOwnPropertyNames(obj))
      {
        const value = (obj as any)[key];
        if (typeof value === 'object')
          proxy[key] = makeProxy(value, [...path, key]);
        else
          proxy[key] = value;
      }
    }

    // Include all symbol properties as well, without modification.
    for (const symbol of Object.getOwnPropertySymbols(obj))
      proxy[symbol] = obj[symbol];

    // Add custom methods as symbol properties, so that they don't interfere with regular usage.
    proxy[changeSubtree] = (changeSubtreeCallback: (subtree: U) => void) => {
      // `changeSubtree` operates on `A.DocHandle` directly.
      // The changes to the `A.DocHandle` are then applied to `newObj` via
      // the `on('change')` handler.
      handle.change((doc: A.Doc<T>) => {
        var subtree: any = doc;
        for (const pathSegment of path)
          subtree = subtree[pathSegment];
        changeSubtreeCallback(subtree);
      })
    }

    // FIXME: Slow? https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/setPrototypeOf
    // Object.setPrototypeOf(proxy, Object.getPrototypeOf(obj));
    return proxy as MyProxy<U>;
  }

  const docProxy: MyProxy<A.Doc<T>> = makeProxy(handle.doc(), []);
  const docRef = ref<MyProxy<A.Doc<T>>>(docProxy) as Ref<MyProxy<A.Doc<T>>>;

  handle.on('change', (payload) => {
    console.trace("[automerge-diy-vue-hooks] Got 'change' event, applying patches.", payload);
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
