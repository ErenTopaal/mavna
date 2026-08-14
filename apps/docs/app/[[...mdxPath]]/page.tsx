import { generateStaticParamsFor, importPage } from "nextra/pages";
import type { ReactElement } from "react";
import { useMDXComponents as getMDXComponents } from "../../mdx-components";

export const generateStaticParams = generateStaticParamsFor("mdxPath");

interface PageProps {
  readonly params: Promise<{ readonly mdxPath?: string[] }>;
}

export async function generateMetadata(props: PageProps): Promise<Record<string, unknown>> {
  const params = await props.params;
  const { metadata } = await importPage(params.mdxPath);
  return metadata;
}

const Wrapper = getMDXComponents().wrapper;

export default async function Page(props: PageProps): Promise<ReactElement> {
  const params = await props.params;
  const { default: MDXContent, toc, metadata, sourceCode } = await importPage(params.mdxPath);
  if (Wrapper === undefined) return <MDXContent {...props} params={params} />;
  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  );
}
