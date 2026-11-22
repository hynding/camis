<?php

declare(strict_types=1);

namespace App\Filament\Resources\Ledgers\Schemas;

use App\Filament\Resources\Ledgers\LedgerResource;
use App\Models\Ledger;
use App\Support\StrapiContentManager;
use Filament\Actions\Action;
use Filament\Actions\BulkActionGroup;
use Filament\Actions\DeleteAction;
use Filament\Actions\DeleteBulkAction;
use Filament\Notifications\Notification;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\QueryBuilder\Constraints\DateConstraint;
use Filament\Tables\Filters\QueryBuilder\Constraints\NumberConstraint;
use Filament\Tables\Filters\QueryBuilder\Constraints\RelationshipConstraint;
use Filament\Tables\Filters\QueryBuilder\Constraints\RelationshipConstraint\Operators\IsRelatedToOperator;
use Filament\Tables\Filters\QueryBuilder\Constraints\TextConstraint;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

class LedgersTable
{
    public static function configure(Table $table): Table
    {
        return StrapiContentManager::table($table, LedgerResource::CONTENT_MANAGER, columns: [
            'id' => TextColumn::make('id')->sortable(),
            'label' => TextColumn::make('label')->searchable()->sortable(),
            'balance' => TextColumn::make('balance')->searchable(query: fn (Builder $query, string $search): Builder => \App\Support\DecimalDigits::where($query, 'balance', '$eq', $search, 20, 6) ? $query : $query->whereRaw('0 = 1'))->sortable(),
            'rate' => TextColumn::make('rate')->searchable(query: fn (Builder $query, string $search): Builder => \App\Support\DecimalDigits::where($query, 'rate', '$eq', $search, 9, 4) ? $query : $query->whereRaw('0 = 1'))->sortable(),
            'share' => TextColumn::make('share')->searchable(query: fn (Builder $query, string $search): Builder => \App\Support\DecimalDigits::where($query, 'share', '$eq', $search, 15, 5) ? $query : $query->whereRaw('0 = 1'))->sortable(),
            'units' => TextColumn::make('units')->searchable(query: fn (Builder $query, string $search): Builder => \App\Support\DecimalDigits::where($query, 'units', '$eq', $search, 14, 4) ? $query : $query->whereRaw('0 = 1'))->sortable(),
            'fee' => TextColumn::make('fee')->searchable(query: fn (Builder $query, string $search): Builder => is_numeric($search) ? $query->where('fee', $search) : $query->whereRaw('0 = 1'))->sortable(),
            'createdAt' => TextColumn::make('created_at')->dateTime()->sortable(),
            'updatedAt' => TextColumn::make('updated_at')->dateTime()->sortable(),
            'createdBy' => TextColumn::make('createdBy.firstname')->sortable(),
            'updatedBy' => TextColumn::make('updatedBy.firstname')->sortable(),
        ], constraints: [
            'id' => NumberConstraint::make('id'),
            'label' => TextConstraint::make('label')->nullable(),
            'balance' => NumberConstraint::make('balance')->nullable(),
            'rate' => NumberConstraint::make('rate')->nullable(),
            'share' => NumberConstraint::make('share')->nullable(),
            'units' => NumberConstraint::make('units')->nullable(),
            'fee' => NumberConstraint::make('fee')->nullable(),
            'createdAt' => DateConstraint::make('created_at'),
            'updatedAt' => DateConstraint::make('updated_at'),
            'createdBy' => RelationshipConstraint::make('createdBy')->selectable(IsRelatedToOperator::make()->titleAttribute('firstname')->searchable()->multiple()),
            'updatedBy' => RelationshipConstraint::make('updatedBy')->selectable(IsRelatedToOperator::make()->titleAttribute('firstname')->searchable()->multiple()),
        ])
            ->recordActions([
                Action::make('duplicate')
                    ->label('Duplicate')
                    ->icon('heroicon-o-document-duplicate')
                    ->visible(fn (): bool => LedgerResource::canCreate())
                    ->action(function (Ledger $record, $livewire): void {
                        $copy = LedgerResource::duplicate($record);
                        Notification::make()->success()->title('Duplicated')->send();
                        $livewire->redirect(LedgerResource::getUrl('edit', ['record' => $copy]));
                    }),
                DeleteAction::make(),
            ])
            ->toolbarActions(StrapiContentManager::bulkActions(LedgerResource::CONTENT_MANAGER, [
                BulkActionGroup::make([
                    DeleteBulkAction::make()->authorizeIndividualRecords(),
                ]),
            ]));
    }
}
