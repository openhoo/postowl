const METHOD_CLASSES: Record<string, string> = {
  GET: 'method-get text-signal-ink',
  POST: 'method-post text-method-post',
  PUT: 'method-put text-method-put',
  PATCH: 'method-patch text-method-patch',
  DELETE: 'method-delete text-coral-ink',
  HEAD: 'method-head text-signal-ink',
  OPTIONS: 'method-options text-signal-ink'
};

const DEFAULT_GEOMETRY = 'min-w-11 font-data text-[0.6875rem] leading-none font-[750]';
const TREE_GEOMETRY = 'tree-method min-w-10 font-data text-[0.625rem] leading-none font-[750] tracking-[0.02em]';

export interface MethodTagProps {
  method: string;
  tree?: boolean;
  class?: string;
}

export default function MethodTag(props: MethodTagProps) {
  const normalizedMethod = () => props.method.toUpperCase();
  const methodClass = () => METHOD_CLASSES[normalizedMethod()] ?? METHOD_CLASSES.GET;

  return (
    <span class={`method-tag ${props.tree ? TREE_GEOMETRY : DEFAULT_GEOMETRY} ${methodClass()} ${props.class ?? ''}`}>
      {props.method}
    </span>
  );
}
