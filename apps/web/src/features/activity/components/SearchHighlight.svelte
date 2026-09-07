<script lang="ts">
  let { text, query }: { text: string; query: string } = $props();
  const index = $derived(
    query.trim() ? text.toLowerCase().indexOf(query.trim().toLowerCase()) : -1,
  );
</script>

{#if index < 0}{text}{:else}{text.slice(0, index)}<mark
    class="rounded bg-steel/15 text-inherit"
    >{text.slice(index, index + query.trim().length)}</mark
  >{text.slice(index + query.trim().length)}{/if}
