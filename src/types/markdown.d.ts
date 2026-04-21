// TypeScript declaration for markdown files imported as raw text strings.
// tsup handles the actual bundling via loader: { ".md": "text" }.
declare module "*.md" {
  const content: string;
  export default content;
}
