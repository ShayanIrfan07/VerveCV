declare module "nspell" {
  export interface NSpellDictionary {
    aff: string | Uint8Array;
    dic: string | Uint8Array;
  }

  export interface NSpellInstance {
    correct(word: string): boolean;
    suggest(word: string): string[];
    add(word: string, model?: string): NSpellInstance;
    remove(word: string): NSpellInstance;
    personal(dic: string | Uint8Array): NSpellInstance;
  }

  function nspell(
    affOrDictionary: string | Uint8Array | NSpellDictionary | NSpellDictionary[],
    dic?: string | Uint8Array,
  ): NSpellInstance;

  export default nspell;
}
