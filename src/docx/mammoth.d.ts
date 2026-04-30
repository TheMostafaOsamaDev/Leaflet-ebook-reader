// Minimal ambient declaration for mammoth's browser bundle. The package
// ships TS types only for its Node entrypoint, but the API surface we use
// is identical for both — these are just the bits we touch.

declare module "mammoth/mammoth.browser" {
  export interface Image {
    contentType: string;
    readAsArrayBuffer(): Promise<ArrayBuffer>;
    readAsBase64String(): Promise<string>;
  }

  export interface ImageAttributes {
    src: string;
    alt?: string;
  }

  // Branded type — only `images.imgElement(...)` / `images.dataUri` should
  // produce values of this type, you can't construct one yourself.
  export interface ImageConverter {
    __mammothBrand: "ImageConverter";
  }

  export interface Options {
    convertImage?: ImageConverter;
    styleMap?: string | string[];
    includeDefaultStyleMap?: boolean;
    ignoreEmptyParagraphs?: boolean;
  }

  export interface Message {
    type: "warning" | "error";
    message: string;
  }

  export interface Result {
    value: string;
    messages: Message[];
  }

  export interface MammothApi {
    convertToHtml(
      input: { arrayBuffer: ArrayBuffer },
      options?: Options,
    ): Promise<Result>;
    images: {
      imgElement(
        handler: (image: Image) => Promise<ImageAttributes>,
      ): ImageConverter;
      dataUri: ImageConverter;
    };
  }

  const mammoth: MammothApi;
  export default mammoth;
}
