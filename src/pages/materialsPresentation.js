const STAGE_KEYS = ['receipt', 'order', 'arrival'];

function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function deriveMaterialsPresentation(summary, arrivalCheckNeeds) {
  const stages = Object.fromEntries(STAGE_KEYS.map(key => {
    const source = summary?.stages?.[key] ?? {};
    const complete_count = numeric(source.complete_count);
    const unchecked_count = numeric(source.unchecked_count);
    const needs_review_count = numeric(source.needs_review_count);
    const target_order_count = numeric(source.target_order_count);
    return [key, {
      complete_count,
      unchecked_count,
      needs_review_count,
      target_order_count,
      incomplete_count: unchecked_count + needs_review_count,
    }];
  }));
  const overdue_count = numeric(arrivalCheckNeeds?.overdue_count);
  const today_count = numeric(arrivalCheckNeeds?.today_count);
  const review_order_count = (summary?.companies ?? [])
    .reduce((total, company) => total + numeric(company.review_order_count), 0);
  const max_incomplete_count = Math.max(0, ...Object.values(stages).map(stage => stage.incomplete_count));
  const max_stage_keys = max_incomplete_count > 0
    ? STAGE_KEYS.filter(key => stages[key].incomplete_count === max_incomplete_count)
    : [];
  const total_orders = numeric(summary?.total_orders);
  const show_all_complete = total_orders > 0
    && review_order_count === 0
    && STAGE_KEYS.every(key => (
      stages[key].complete_count === total_orders
      && stages[key].target_order_count === total_orders
    ));
  const urgencyTone = show_all_complete
    ? 'complete'
    : overdue_count > 0
      ? 'overdue'
      : today_count > 0
        ? 'today'
        : 'neutral';

  return {
    stages,
    urgency: {
      overdue_count,
      today_count,
      tone: urgencyTone,
      neutral: urgencyTone === 'neutral',
    },
    review_order_count,
    max_incomplete_count,
    max_stage_keys,
    show_all_complete,
    show_empty: total_orders === 0,
    show_arrival_action: stages.arrival.incomplete_count > 0,
  };
}
