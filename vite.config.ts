import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'Arsel',
      fileName: 'arsel',
      formats: ['es', 'umd'],
    },
    // A tag-based integrator loads this before their own bundle; nothing here
    // may assume a module system exists on the page.
    sourcemap: true,
    rollupOptions: {
      // Without this the UMD global collapses to the default export and a
      // script-tag integrator has to write `Arsel.default.init(...)`.
      output: { exports: 'named' },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    environmentOptions: {
      // The custom-HTML renderer builds real iframes, and happy-dom otherwise
      // tries to FETCH a `src` and execute a `srcdoc` for each one — so the
      // suite would make outbound requests and run test fixture markup. The
      // element and its `contentWindow` still exist, which is all the sandbox
      // and bridge assertions need.
      happyDOM: { settings: { disableIframePageLoading: true } },
    },
  },
});
