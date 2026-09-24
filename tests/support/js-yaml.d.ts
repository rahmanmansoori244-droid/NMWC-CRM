/**
 * The one function the workflow guards use from js-yaml, typed as what it is: an
 * unknown document the caller must narrow. Declared here rather than adding
 * @types/js-yaml, because nothing else in the repository parses YAML.
 */
declare module 'js-yaml' {
  export function load(source: string): unknown;
}
